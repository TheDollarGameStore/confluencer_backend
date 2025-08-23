/*
 * Main application file for the summary-to-speech service.
 *
 * Endpoints:
 *   POST /summaries  -> Summarise input text, TTS each sentence, store in MongoDB
 *   GET  /summaries  -> Return up to 10 random stories in random order
 *
 * Config lives in ./config.js
 */

const express = require('express');
const mongoose = require('mongoose');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
// Cheerio is used to scrape text from HTML pages when a URL is provided
// instead of raw text. Ensure cheerio is installed in your project.
const cheerio = require('cheerio');

const config = require('./config');
const Story = require('./models/story');

/* ----------------------- B2 (S3-compatible) setup ----------------------- */
const b2S3 = new S3Client({
  region: config.region,                 // e.g. "us-west-002"
  endpoint: config.endpoint,             // e.g. "https://s3.us-west-002.backblazeb2.com"
  forcePathStyle: false,                 // B2 supports virtual-hosted style; set true if your setup needs it
  credentials: {
    accessKeyId: config.key || '',
    secretAccessKey: config.secret || '',
  },
});

function b2PublicUrl(key) {
  // Prefer explicit public base from config, else fall back to default pattern
  const base =
    (config.publicUrlBase && config.publicUrlBase.trim()) ||
    `https://f002.backblazeb2.com/file/${config.bucket}`;
  // ensure no trailing slash
  const cleanBase = base.replace(/\/+$/, '');
  return `${cleanBase}/${key}`;
}
/* ----------------------------------------------------------------------- */

// Ensure audio output directory exists (harmless even if unused)
fs.mkdirSync(path.join(__dirname, config.audioDir), { recursive: true });

// --- OpenAI clients ---
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

// Express
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/audio', express.static(path.join(__dirname, config.audioDir))); // kept for backward compat

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
 * The prompt is loaded from config.summarisatonPrompt.
 */
async function generateSummary(inputText) {
  try {
    const resp = await chatClient.chat.completions.create({
      model: config.chatModel,
      messages: [
        { role: 'system', content: config.summarisationPrompt },
        { role: 'user', content: inputText }
      ],
      // omit temperature entirely for max compatibility
    });
    const text = resp?.choices?.[0]?.message?.content?.trim();
    return text || '';
  } catch (err) {
    console.error('generateSummary error:', err);
    return '';
  }
}


/**
 * Parse the structured summary format defined in the prompt.
 *
 * The summarisation prompt instructs the model to output a series of
 * blocks formatted like:
 *
 * "sentence": "text here"
 * "action": "action name"
 * END_SENTENCE
 *
 * ... repeated for each sentence ...
 *
 * At the end of all sentences, the script contains the marker END_SUMMARY.
 * This function extracts each sentence/action pair into an array of
 * objects. If the script does not match the expected format, it falls
 * back to splitting on punctuation similar to the previous behaviour.
 *
 * @param {string} script The raw summary text returned by the chat model
 * @returns {Array<{ sentence: string, action: string|null }>} Array of parsed sentences and actions
 */
function parseStructuredScript(script) {
  if (!script || typeof script !== 'string') return [];
  let text = script.trim();
  // Remove the END_SUMMARY marker and anything that follows
  const endIdx = text.indexOf('END_SUMMARY');
  if (endIdx !== -1) {
    text = text.substring(0, endIdx);
  }
  const parts = text.split(/END_SENTENCE\s*/i).map((p) => p.trim()).filter(Boolean);
  const result = [];
  for (const part of parts) {
    // Look for "sentence": "..."
    const sentenceMatch = part.match(/"sentence"\s*:\s*"([^"]*)"/i);
    // action is optional
    const actionMatch = part.match(/"action"\s*:\s*"([^"]*)"/i);
    const sentence = sentenceMatch ? sentenceMatch[1] : null;
    const action = actionMatch ? actionMatch[1] : null;
    if (sentence && sentence.length > 0) {
      result.push({ sentence, action });
    }
  }
  // Fallback: if nothing matched, just split on punctuation to avoid empty results
  if (result.length === 0) {
    const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    return sentences.map((s) => ({ sentence: s, action: null }));
  }
  return result;
}

/**
 * Uses the TTS API to generate an MP3 buffer for a sentence.
 * Update the payload if your TTS server expects different fields.
 */
async function generateSpeech(text) {
  // Example: Kokoro-style local API
  const speech = await ttsClient.audio.speech.create({
    model: config.ttsModel,
    voice: config.ttsVoice,
    input: text,
    speed: config.ttsSpeed,
    // Some servers accept { response_format: 'mp3' } if needed
  });
  const audioBuffer = Buffer.from(await speech.arrayBuffer());
  return audioBuffer;
}

/** POST /summaries */
app.post('/summaries', async (req, res) => {
  try {
    // Allow callers to provide either a raw text string or a URL to scrape.
    const { text, url } = req.body;
    // Validate that at least one of text or url is provided
    if ((!text || typeof text !== 'string' || !text.trim()) &&
        (!url || typeof url !== 'string' || !url.trim())) {
      return res.status(400).json({ error: 'Missing or empty `text` or `url` field.' });
    }

    // Determine the content to summarise. Default to `text` if provided.
    let inputContent = text;

    // If a URL is provided, fetch the page and extract human-readable content
    if (url && typeof url === 'string' && url.trim()) {
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
        }
        const html = await response.text();
        const $ = cheerio.load(html);

        // Extract candidate text content: headings, paragraphs, article content
        const paragraphs = [];
        $('main, article, section, h1, h2, h3, p, li').each((_, el) => {
          const txt = $(el).text().trim();
          if (txt) paragraphs.push(txt);
        });
        let extracted = paragraphs.join(' ');
        // Fallback to the entire body text if no paragraphs were captured
        if (!extracted) {
          extracted = $('body').text().replace(/\s+/g, ' ').trim();
        }
        inputContent = extracted;
      } catch (err) {
        console.error('Error fetching or parsing URL:', err);
        return res.status(400).json({ error: 'Unable to fetch or parse the provided URL.' });
      }
    }

    // Summarise the extracted or provided text
    const summary = await generateSummary(inputContent);
    if (!summary) return res.status(502).json({ error: 'Failed to generate summary.' });

    // Parse the structured script into sentence/action pairs
    const parsed = parseStructuredScript(summary);
    if (parsed.length === 0) {
      return res.status(502).json({ error: 'Empty or invalid summary returned.' });
    }
    // The first sentence acts as the title
    const title = parsed[0].sentence || 'Summary';
    // Generate audio for each sentence and build the sections array
    const sections = [];
    for (const { sentence, action } of parsed) {
      const filename = `${uuidv4()}.mp3`;
      const filePath = path.join(__dirname, config.audioDir, filename);
      const audioBuffer = await generateSpeech(sentence);

      // Upload to Backblaze B2
      await b2S3.send(new PutObjectCommand({
        Bucket: config.bucket,          // <<< fixed to use config
        Key: filename,
        Body: audioBuffer,
        ContentType: 'audio/mpeg',
      }));

      const publicUrl = b2PublicUrl(filename);
      // Include the action if provided
      const section = { text: sentence, audio: publicUrl };
      if (action) section.action = action;
      sections.push(section);
    }

    // Persist
    const story = await Story.create({ title, sections });

    return res.status(201).json(story);
  } catch (err) {
    console.error('POST /summaries error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/** GET /summaries -> return the whole DB shuffled */
app.get('/summaries', async (_req, res) => {
  try {
    // Fetch everything
    const docs = await Story.find({}).lean();

    // Shuffle in memory
    const shuffled = shuffle(docs);

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
