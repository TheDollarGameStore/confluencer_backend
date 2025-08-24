/*
 * Summary-to-speech service (multi-confluencer).
 * - POST /summaries   -> generate BOTH Brain and Girl sections (with persona voices)
 * - GET  /summaries?confluencer=Brain|Girl -> return stories with ONLY that persona’s sections
 *
 * Cloudinary for hosting .mp3 (direct URLs).
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

async function uploadToCloudinary(localFilePath, filenameNoExt) {
  const res = await cloudinary.uploader.upload(localFilePath, {
    resource_type: 'video',
    folder: config.cloudinaryFolder,
    public_id: filenameNoExt,
    overwrite: true,
    format: 'mp3',
  });
  return res.secure_url;
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
fs.mkdirSync(path.join(__dirname, config.audioDir), { recursive: true });
app.use('/audio', express.static(path.join(__dirname, config.audioDir))); // optional legacy local serving

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

async function generateSpeech(text, voice) {
  const speech = await ttsClient.audio.speech.create({
    model: config.ttsModel,
    voice,
    input: text,
    speed: config.ttsSpeed,
  });
  return Buffer.from(await speech.arrayBuffer());
}

async function fetchAndExtract(url) {
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
  return extracted;
}

// System messages per persona combine structurePrompt + that persona’s voice prompt.
function buildSystemPrompt(persona) {
  const p = config.confluencerPrompts?.[persona] || '';
  return `${config.structurePrompt}\n\n${p}`.trim();
}

async function generatePersonaScript(inputText, persona) {
  const resp = await chatClient.chat.completions.create({
    model: config.chatModel,
    messages: [
      { role: 'system', content: buildSystemPrompt(persona) },
      { role: 'user', content: inputText },
    ],
  });
  return resp?.choices?.[0]?.message?.content?.trim() || '';
}

async function ttsAndUploadSections(parsed, voice) {
  const out = [];
  for (const { sentence, action } of parsed) {
    const id = uuidv4();
    const filename = `${id}.mp3`;
    const filePath = path.join(__dirname, config.audioDir, filename);

    const audioBuffer = await generateSpeech(sentence, voice);
    fs.writeFileSync(filePath, audioBuffer);

    const secureUrl = await uploadToCloudinary(filePath, id);
    try { fs.unlinkSync(filePath); } catch {}

    const section = { text: sentence, key: secureUrl };
    if (action) section.action = action;
    out.push(section);
  }
  return out;
}

/* -------------------------------- Endpoints -------------------------------- */
/** POST /summaries
 * Body: { text?: string, url?: string }
 * Generates BOTH personas and stores them separately.
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

    let inputContent = text;
    if (!inputContent && url) {
      try {
        inputContent = await fetchAndExtract(url);
      } catch (err) {
        console.error('Error fetching or parsing URL:', err);
        return res.status(400).json({ error: 'Unable to fetch or parse the provided URL.' });
      }
    }

    // Generate per-persona scripts (using shared structure + persona tone)
    const [brainScript, girlScript, financerScript] = await Promise.all([
      generatePersonaScript(inputContent, 'Brain'),
      generatePersonaScript(inputContent, 'Girl'),
      generatePersonaScript(inputContent, 'Financer'),
    ]);

    const brainParsed = parseStructuredScript(brainScript);
    const girlParsed = parseStructuredScript(girlScript);
    const financerParsed = parseStructuredScript(financerScript);

    if (!brainParsed.length && !girlParsed.length) {
      return res.status(502).json({ error: 'Failed to generate summaries.' });
    }

    // Title: prefer first Brain sentence; otherwise Girl; otherwise fallback.
    const title =
      brainParsed[0]?.sentence ||
      girlParsed[0]?.sentence ||
      financerParsed[0]?.sentence ||
      'Summary';

    // TTS & upload for each persona with its own voice
    const [sectionsBrain, sectionsGirl, sectionsFinancer] = await Promise.all([
      ttsAndUploadSections(brainParsed,    config.ttsVoices.Brain),
      ttsAndUploadSections(girlParsed,     config.ttsVoices.Girl),
      ttsAndUploadSections(financerParsed, config.ttsVoices.Financer),
    ]);

    const story = await Story.create({
      title,
      sectionsBrain,
      sectionsGirl,
      sectionsFinancer,
      sourceUrl: url || null,
    });

    return res.status(201).json(story);
  } catch (err) {
    console.error('POST /summaries error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/** GET /summaries?confluencer=Brain|Girl
 * Returns the DB (shuffled) but ONLY the requested persona’s sections mapped to `sections`.
 * If no param or invalid value, defaults to Brain.
 * Legacy docs without per-persona fields are mapped to both Brain/Girl as the same content.
 */
app.options('/summaries', corsGetOnly);
app.get('/summaries', corsGetOnly, async (req, res) => {
  try {
    const personaRaw = String(req.query.confluencer || 'Brain');
    let persona = 'Brain';
    if (/girl/i.test(personaRaw)) persona = 'Girl';
    else if (/financer/i.test(personaRaw)) persona = 'Financer';

    const docs = await Story.find({}).lean();

    const mapped = docs.map((story) => {
      // Determine the right bucket for this persona; fall back to legacy sections if needed
      const chosen =
        persona === 'Girl'
          ? (story.sectionsGirl?.length ? story.sectionsGirl : story.sections)
        : persona === 'Financer'
          ? (story.sectionsFinancer?.length ? story.sectionsFinancer : story.sections)
        : (story.sectionsBrain?.length ? story.sectionsBrain : story.sections);

      // Normalize to { text, action, audio } with mp3 URL in `audio`
      const sections = (chosen || []).map((s) => {
        const audio =
          s.key && (s.key.includes('res.cloudinary.com') || s.key.endsWith('.mp3'))
            ? s.key
            : s.audio;
        return { text: s.text, action: s.action ?? null, audio };
      });

      return {
        _id: story._id,
        title: story.title,
        sections,
        sourceUrl: story.sourceUrl || null,
        createdAt: story.createdAt,
        updatedAt: story.updatedAt,
      };
    });

    return res.json(shuffle(mapped));
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
