/*
 * Main application file for the summary-to-speech service.
 *
 * Endpoints:
 *   POST /summaries  -> Summarise input text or URL, TTS each sentence, upload to B2, store in Mongo (store object keys, not URLs)
 *   GET  /summaries  -> Return all stories, each section includes a fresh presigned audio URL
 *
 * Requires ./config.js and ./models/story.js
 */

const express = require('express');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));
const cheerio = require('cheerio');
const cors = require('cors');

const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const config = require('./config');
const Story = require('./models/story');

/* ----------------------------- CORS (GET-only) ----------------------------- */
/**
 * Only allow your Vercel frontend to make **GET** requests. We do **not**
 * attach CORS to POST, so browsers can’t call it cross-origin; tools like
 * Postman still work fine.
 */
const allowedOrigins =
  (config.corsAllowedOrigins || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

const corsGetOnly = cors({
  origin(origin, cb) {
    // Allow server-to-server (no Origin) and explicit allowed origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
});

/* ----------------------- Backblaze B2 (S3-compatible) setup ----------------------- */
function mask(s) { return s ? s.slice(0, 4) + '…(' + s.length + ')' : 'MISSING'; }
function assertB2Config(cfg) {
  console.log('[B2 CONFIG]',
    '\n bucket   =', cfg.bucket || 'MISSING',
    '\n region   =', cfg.region || 'MISSING',
    '\n endpoint =', cfg.endpoint || 'MISSING',
    '\n keyID    =', mask(cfg.key),
    '\n secret   =', cfg.secret ? `(len:${cfg.secret.length})` : 'MISSING'
  );
  const errs = [];
  if (!cfg.bucket || cfg.bucket === '-') errs.push('B2_BUCKET is missing or invalid.');
  if (!cfg.key || cfg.key.length < 20) errs.push('B2_KEY (Key ID) looks invalid/short.');
  if (!cfg.secret || cfg.secret.length < 20) errs.push('B2_SECRET looks invalid/short.');
  if (!cfg.region) errs.push('B2_REGION missing.');
  if (!cfg.endpoint) errs.push('B2_ENDPOINT missing.');
  if (errs.length) throw new Error('Backblaze B2 config error:\n - ' + errs.join('\n - '));
}
assertB2Config(config);

const b2S3 = new S3Client({
  region: config.region,                     // e.g. "us-east-005"
  endpoint: config.endpoint,                 // e.g. "https://s3.us-east-005.backblazeb2.com"
  forcePathStyle: /\./.test(config.bucket),  // only true if bucket has dots
  credentials: {
    accessKeyId: config.key,
    secretAccessKey: config.secret,
  },
});

async function presignAudio(key, expiresSeconds = 3600) {
  const cmd = new GetObjectCommand({ Bucket: config.bucket, Key: key });
  return getSignedUrl(b2S3, cmd, { expiresIn: expiresSeconds });
}

// Optional: for public buckets only (kept here for reference)
function b2PublicUrl(key) {
  const base =
    (config.publicUrlBase && config.publicUrlBase.trim()) ||
    `https://f005.backblazeb2.com/file/${config.bucket}`; // fXXX should match region if you use this
  const cleanBase = base.replace(/\/+$/, '');
  return `${cleanBase}/${key}`;
}
/* ---------------------------------------------------------------------------------- */

// Ensure audio output dir exists (for local debug; uploads go to B2)
fs.mkdirSync(path.join(__dirname, config.audioDir), { recursive: true });

/* ------------------------------ OpenAI clients ----------------------------------- */
// Chat client (summarisation)
const chatClient = new OpenAI({
  apiKey: config.openAiChatApiKey,
  baseURL: config.openAiChatApiUrl,
});

// TTS client (can point to a DIFFERENT baseURL/API key than chat)
const ttsClient = new OpenAI({
  apiKey: config.openAiTtsApiKey,
  baseURL: config.openAiTtsApiUrl,
});
/* ---------------------------------------------------------------------------------- */

// Express
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/audio', express.static(path.join(__dirname, config.audioDir))); // legacy local serving

// Mongo
mongoose
  .connect(config.mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

/** Simple Fisher–Yates shuffle */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Generate a summary script using the chat model.
 */
async function generateSummary(inputText) {
  try {
    const resp = await chatClient.chat.completions.create({
      model: config.chatModel,
      messages: [
        { role: 'system', content: config.summarisationPrompt },
        { role: 'user', content: inputText }
      ],
    });
    const text = resp?.choices?.[0]?.message?.content?.trim();
    return text || '';
  } catch (err) {
    console.error('generateSummary error:', err);
    return '';
  }
}

/**
 * Parse the structured summary from the prompt.
 * Expects blocks like:
 *   "sentence": "..."
 *   "action": "..."
 *   END_SENTENCE
 * ending with END_SUMMARY
 */
function parseStructuredScript(script) {
  if (!script || typeof script !== 'string') return [];
  let text = script.trim();
  const endIdx = text.indexOf('END_SUMMARY');
  if (endIdx !== -1) {
    text = text.substring(0, endIdx);
  }
  const parts = text.split(/END_SENTENCE\s*/i).map((p) => p.trim()).filter(Boolean);
  const result = [];
  for (const part of parts) {
    const sentenceMatch = part.match(/"sentence"\s*:\s*"([^"]*)"/i);
    const actionMatch = part.match(/"action"\s*:\s*"([^"]*)"/i);
    const sentence = sentenceMatch ? sentenceMatch[1] : null;
    const action = actionMatch ? actionMatch[1] : null;
    if (sentence && sentence.length > 0) {
      result.push({ sentence, action });
    }
  }
  if (result.length === 0) {
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    return sentences.map((s) => ({ sentence: s, action: null }));
  }
  return result;
}

/**
 * Generate MP3 buffer via TTS API.
 */
async function generateSpeech(text) {
  const speech = await ttsClient.audio.speech.create({
    model: config.ttsModel,
    voice: config.ttsVoice,
    input: text,
    speed: config.ttsSpeed,
  });
  const audioBuffer = Buffer.from(await speech.arrayBuffer());
  return audioBuffer;
}

/** POST /summaries
 * Body: { text?: string, url?: string }
 * NOTE: No CORS middleware here on purpose (frontend shouldn’t call POST).
 */
app.post('/summaries', async (req, res) => {
  try {
    const { text, url } = req.body;

    if ((!text || typeof text !== 'string' || !text.trim()) &&
        (!url || typeof url !== 'string' || !url.trim())) {
      return res.status(400).json({ error: 'Missing or empty `text` or `url` field.' });
    }

    // Acquire input content (prefer text; else scrape url)
    let inputContent = text;
    if (!inputContent && url) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();
        const $ = cheerio.load(html);

        const parts = [];
        $('main, article, section, h1, h2, h3, p, li').each((_, el) => {
          const txt = $(el).text().trim();
          if (txt) parts.push(txt);
        });
        let extracted = parts.join(' ');
        if (!extracted) {
          extracted = $('body').text().replace(/\s+/g, ' ').trim();
        }
        inputContent = extracted;
      } catch (err) {
        console.error('Error fetching or parsing URL:', err);
        return res.status(400).json({ error: 'Unable to fetch or parse the provided URL.' });
      }
    }

    // Summarise
    const summary = await generateSummary(inputContent);
    if (!summary) return res.status(502).json({ error: 'Failed to generate summary.' });

    // Parse
    const parsed = parseStructuredScript(summary);
    if (parsed.length === 0) {
      return res.status(502).json({ error: 'Empty or invalid summary returned.' });
    }

    const title = parsed[0].sentence || 'Summary';

    // TTS + Upload each sentence; store object key only
    const sections = [];
    for (const { sentence, action } of parsed) {
      const filename = `${uuidv4()}.mp3`;
      const filePath = path.join(__dirname, config.audioDir, filename);

      // Generate speech
      const audioBuffer = await generateSpeech(sentence);

      // Optional: keep a local copy (handy for debugging)
      try { fs.writeFileSync(filePath, audioBuffer); } catch {}

      // Upload to B2
      try {
        await b2S3.send(new PutObjectCommand({
          Bucket: config.bucket,
          Key: filename,
          Body: audioBuffer,
          ContentType: 'audio/mpeg',
        }));
      } catch (e) {
        console.error('B2 PutObject failed:', {
          code: e?.Code || e?.name,
          http: e?.$metadata?.httpStatusCode,
          reqId: e?.$metadata?.requestId,
          msg: e?.message,
        });
        throw e;
      }

      // Store only key; presign on GET
      const section = { text: sentence, key: filename };
      if (action) section.action = action;
      sections.push(section);
    }

    const story = await Story.create({ title, sections });
    return res.status(201).json(story);
  } catch (err) {
    console.error('POST /summaries error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/** GET /summaries -> return the whole DB shuffled, with presigned URLs
 * CORS is attached here so your Vercel app can call it.
 */
app.options('/summaries', corsGetOnly); // good hygiene for preflight (even though GET doesn’t need it)
app.get('/summaries', corsGetOnly, async (_req, res) => {
  try {
    const docs = await Story.find({}).lean();

    const withUrls = await Promise.all(
      docs.map(async (story) => {
        const sections = await Promise.all(
          (story.sections || []).map(async (s) => {
            // If new docs have 'key', presign; else if legacy has 'audio', pass through
            const audio = s.key ? await presignAudio(s.key, 3600) : s.audio;
            return { ...s, audio };
          })
        );
        return { ...story, sections };
      })
    );

    const shuffled = shuffle(withUrls);
    return res.json(shuffled);
  } catch (err) {
    console.error('GET /summaries error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Summary TTS service listening on port ${port}`);
});
