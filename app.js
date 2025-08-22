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

const config = require('./config');
const Story = require('./models/story');

// Ensure audio output directory exists
fs.mkdirSync(path.join(__dirname, config.audioDir), { recursive: true });

// --- OpenAI clients ---
// Chat client (summarisation)
const chatClient = new OpenAI({
  apiKey: config.openAiChatApiKey,
  baseURL: config.openAiChatApiUrl,
});

// TTS client (can point to a DIFFERENT baseURL/API key than chat)
const ttsClient = new OpenAI({
  apiKey:
    config.openAiTtsApiKey,
    baseURL: config.openAiTtsApiUrl,
});

// Express
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/audio', express.static(path.join(__dirname, config.audioDir)));

// Mongo
mongoose
  .connect(config.mongoUri, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

/** Split summary into sentences (simple heuristic) */
function splitIntoSentences(text) {
  if (!text) return [];
  return text
    .replace(/\r\n/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Fisher-Yates shuffle */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Call OpenAI Chat to generate a summary (title as first sentence) */
async function generateSummary(text) {
  const resp = await chatClient.chat.completions.create({
    model: config.chatModel,
    messages: [
      { role: 'system', content: config.summarisationPrompt },
      { role: 'user', content: text },
    ],
  });
  const out = resp.choices?.[0]?.message?.content || '';
  return out.trim();
}

/** Call OpenAI TTS to generate MP3 for a sentence */
async function generateSpeech(sentence) {
  const speech = await ttsClient.audio.speech.create({
    model: config.ttsModel, // e.g. 'tts-1' (or your compatible server model)
    voice: config.ttsVoice, // e.g. 'alloy' / 'bm_daniel'
    input: sentence,
    speed: config.ttsSpeed,
    // Some servers accept { response_format: 'mp3' } if needed
  });
  const audioBuffer = Buffer.from(await speech.arrayBuffer());
  return audioBuffer;
}

/** POST /summaries */
app.post('/summaries', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Missing or empty `text`.' });
    }

    // Summarise
    const summary = await generateSummary(text);
    if (!summary) return res.status(502).json({ error: 'Failed to generate summary.' });

    // Split & prepare title
    const sentences = splitIntoSentences(summary);
    if (sentences.length === 0) return res.status(502).json({ error: 'Empty summary returned.' });
    const title = sentences[0] || 'Summary';

    // TTS each sentence -> save MP3 -> build sections
    const sections = [];
    for (const sentence of sentences) {
      const filename = `${uuidv4()}.mp3`;
      const filePath = path.join(__dirname, config.audioDir, filename);
      const audioBuffer = await generateSpeech(sentence);
      await fs.promises.writeFile(filePath, audioBuffer);
      sections.push({ text: sentence, audio: `/audio/${filename}` });
    }

    // Persist
    const story = await Story.create({ title, sections });

    return res.status(201).json(story);
  } catch (err) {
    console.error('POST /summaries error:', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/** GET /summaries -> up to 10 random stories (shuffled) */
app.get('/summaries', async (_req, res) => {
  try {
    const docs = await Story.aggregate([{ $sample: { size: 10 } }]);
    return res.json(shuffle(docs));
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
