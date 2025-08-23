/*
 * Main application file for the summary-to-speech service.
 * Now uses Cloudinary for mp3 hosting (public, direct .mp3 URLs).
 *
 * Endpoints:
 *   POST /summaries  -> Summarise input text or URL, TTS each sentence, upload to Cloudinary, store Cloudinary URL in Mongo
 *   GET  /summaries  -> Return all stories (shuffled), each section includes a Cloudinary .mp3 link in `audio`
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
const { v2: cloudinary } = require('cloudinary');

const config = require('./config');
const Story = require('./models/story');

/* ----------------------------- CORS (GET-only) ----------------------------- */
const allowedOrigins = (config.corsAllowedOrigins || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const corsGetOnly = cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  methods: ['GET'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
});

/* --------------------------- Cloudinary connection -------------------------- */
cloudinary.config({
  cloud_name: config.cloudName,
  api_key: config.cloudApiKey,
  api_secret: config.cloudApiSecret,
  secure: true,
});

// Upload a local mp3 file to Cloudinary and return the secure mp3 URL
async function uploadToCloudinary(localFilePath, filenameNoExt) {
  // Use resource_type "video" for audio (Cloudinary convention) so we get a .mp3 URL
  const res = await cloudinary.uploader.upload(localFilePath, {
    resource_type: 'video',
    folder: config.cloudinaryFolder,
    public_id: filenameNoExt, // do not include extension
    overwrite: true,
    format: 'mp3', // ensure URL ends in .mp3
  });
  return res.secure_url; // typically .../video/upload/.../<public_id>.mp3
}

/* ------------------------------ OpenAI clients ----------------------------- */
const chatClient = new OpenAI({
  apiKey: config.openAiChatApiKey,
  baseURL: config.openAiChatApiUrl,
});
const ttsClient = new OpenAI({
  apiKey: config.openAiTtsApiKey,
  baseURL: config.openAiTtsApiUrl,
});

/* --------------------------------- Express -------------------------------- */
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/audio', express.static(path.join(__dirname, config.audioDir))); // legacy local serving (optional)

/* --------------------------------- Mongo ---------------------------------- */
mongoose
  .connect(config.mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('MongoDB connected'))
  .catch((err) => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

/* --------------------------------- Utils ---------------------------------- */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function generateSummary(inputText) {
  try {
    const resp = await chatClient.chat.completions.create({
      model: config.chatModel,
      messages: [
        { role: 'system', content: config.summarisationPrompt },
        { role: 'user', content: inputText },
      ],
    });
    const text = resp?.choices?.[0]?.message?.content?.trim();
    return text || '';
  } catch (err) {
    console.error('generateSummary error:', err);
    return '';
  }
}

function parseStructuredScript(script) {
  if (!script || typeof script !== 'string') return [];
  let text = script.trim();
  const endIdx = text.indexOf('END_SUMMARY');
  if (endIdx !== -1) text = text.substring(0, endIdx);

  const parts = text
    .split(/END_SENTENCE\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);

  const result = [];
  for (const part of parts) {
    const sentenceMatch = part.match(/"sentence"\s*:\s*"([^"]*)"/i);
    const actionMatch = part.match(/"action"\s*:\s*"([^"]*)"/i);
    const sentence = sentenceMatch ? sentenceMatch[1] : null;
    const action = actionMatch ? actionMatch[1] : null;
    if (sentence && sentence.length > 0) result.push({ sentence, action });
  }
  if (result.length === 0) {
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    return sentences.map((s) => ({ sentence: s, action: null }));
  }
  return result;
}

async function generateSpeech(text) {
  const speech = await ttsClient.audio.speech.create({
    model: config.ttsModel,
    voice: config.ttsVoice,
    input: text,
    speed: config.ttsSpeed,
  });
  return Buffer.from(await speech.arrayBuffer());
}

// Ensure local audio scratch dir exists
fs.mkdirSync(path.join(__dirname, config.audioDir), { recursive: true });

/* -------------------------------- Endpoints -------------------------------- */
/** POST /summaries
 * Body: { text?: string, url?: string }
 * NOTE: No CORS on POST (frontend shouldn’t call it).
 */
app.post('/summaries', async (req, res) => {
  try {
    const { text, url } = req.body;
    if (
      (!text || typeof text !== 'string' || !text.trim()) &&
      (!url || typeof url !== 'string' || !url.trim())
    ) {
      return res.status(400).json({ error: 'Missing or empty `text` or `url` field.' });
    }

    // Acquire input content (prefer text; else scrape url)
    let inputContent = text;
    if (!inputContent && url) {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
        const html = await response.text();
        const $ = cheerio.load(html);

        const parts = [];
        $('main, article, section, h1, h2, h3, p, li').each((_, el) => {
          const txt = $(el).text().trim();
          if (txt) parts.push(txt);
        });
        let extracted = parts.join(' ');
        if (!extracted) extracted = $('body').text().replace(/\s+/g, ' ').trim();
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
    if (parsed.length === 0) return res.status(502).json({ error: 'Empty or invalid summary returned.' });

    const title = parsed[0].sentence || 'Summary';

    // TTS + Upload each sentence to Cloudinary; store public URL in "key"
    const sections = [];
    for (const { sentence, action } of parsed) {
      const id = uuidv4();
      const filename = `${id}.mp3`;
      const filePath = path.join(__dirname, config.audioDir, filename);

      // Generate mp3
      const audioBuffer = await generateSpeech(sentence);
      fs.writeFileSync(filePath, audioBuffer);

      // Upload to Cloudinary
      const secureUrl = await uploadToCloudinary(filePath, id);

      // Optional: clean up local file (comment out if you want to keep a cache)
      try {
        fs.unlinkSync(filePath);
      } catch {}

      const section = { text: sentence, key: secureUrl };
      if (action) section.action = action;
      sections.push(section);
    }

    const story = await Story.create({
      title,
      sections,
      sourceUrl: url || null,   // <-- NEW: only set if client posted a url
    });

    return res.status(201).json(story);
  } catch (err) {
    console.error('POST /summaries error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/** GET /summaries -> return the whole DB shuffled, with Cloudinary mp3 URLs
 * CORS is attached here so your Vercel app can call it.
 */
app.options('/summaries', corsGetOnly);
app.get('/summaries', corsGetOnly, async (_req, res) => {
  try {
    const docs = await Story.find({}).lean();

    // Map legacy docs (audio) and new docs (key -> Cloudinary URL) to a uniform `audio`
    const withUrls = docs.map((story) => {
      const sections = (story.sections || []).map((s) => {
        const audio =
          s.key && (s.key.includes('res.cloudinary.com') || s.key.endsWith('.mp3'))
            ? s.key
            : s.audio; // new vs legacy
        return { ...s, audio };
      });
      return { ...story, sections };
    });

    return res.json(shuffle(withUrls));
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
