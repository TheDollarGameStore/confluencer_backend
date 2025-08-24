// Configuration for the summary TTS app with multi-confluencer support.
require('dotenv').config();

module.exports = {
  // ---- Mongo ----
  mongoUri: process.env.MONGO_URI || '',

  // ---- OpenAI (chat + TTS proxy) ----
  openAiChatApiKey: process.env.OPENAI_CHAT_API_KEY || '',
  openAiChatApiUrl: process.env.OPENAI_CHAT_URL || 'https://api.openai.com/v1',

  openAiTtsApiKey: process.env.OPENAI_TTS_API_KEY || 'NOT_REQUIRED',
  openAiTtsApiUrl: process.env.OPENAI_TTS_API_URL || 'http://localhost:8880/v1',

  chatModel: process.env.CHAT_MODEL || 'gpt-5-mini',

  // ---- Prompts ----
  // A single structure/format prompt that defines HOW to output (title first,
  // "sentence"/"action" blocks, END_SENTENCE, END_SUMMARY, etc.).
  structurePrompt:
    process.env.STRUCTURE_PROMPT ||
    `You are producing a short-form script from technical or documentation text.
    Output ONLY the lines to be read aloud (no markdown, no stage directions, no asides).
    The FIRST sentence is the title: short, punchy, and clickbaity.
    No newlines; write as continuous sentences.
    Ignore UI chrome (buttons/menus). Summarize only core content.

    Structure EXACTLY like this for EACH sentence:
    "sentence": "sentence goes here"
    "action": "action name here"
    END_SENTENCE

    At the very end, append:
    END_SUMMARY

    Valid actions:
    thinking
    shrug
    laugh
    disappointed
    confused
    happy
    surprised
    excited
    angry
    explaining1
    explaining2
    explaining3`,

  // Persona prompts: WHAT to sound like (tone, attitude).
  confluencerPrompts: {
    Brain:
      process.env.PROMPT_BRAIN ||
      `Persona: Brain — a witty, slightly snarky "corporate-brain" mascot.
       Tone: playful, clever, unapologetically nerdy. Toss in light jabs at red tape.
       Keep sentences tight and energetic.`,
    Girl:
      process.env.PROMPT_GIRL ||
      `Persona: Girl — upbeat anime-style explainer vibes.
       Tone: friendly, excited, charmingly dramatic clickbait energy.
       Sprinkle light humor and keep momentum high.`,
    Financer:
      process.env.PROMPT_FINANCER ||
      `Persona: Financer — a finance bro who hypes up everything like it's the next big deal.
      Tone: overconfident, energetic, motivational. Uses hype phrases
      ("game-changer", "massive upside", "next-level") and treats every fact like an IPO pitch.`,
  },

  // ---- TTS model settings ----
  ttsModel: process.env.TTS_MODEL || 'kokoro',
  // Persona-specific voices
  ttsVoices: {
    Brain: process.env.TTS_VOICE_BRAIN || 'am_santa',
    Girl: process.env.TTS_VOICE_GIRL || 'af_bella',
    Financer: process.env.TTS_VOICE_FINANCER || 'am_adam', // pick your TTS voice
  },
  ttsSpeed: parseFloat(process.env.TTS_SPEED) || 1.0,

  // Local scratch dir where we briefly write mp3s before uploading.
  audioDir: process.env.AUDIO_DIR || 'audio',

  // ---- Cloudinary ----
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'confluencer-audio',
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudApiSecret: process.env.CLOUDINARY_API_SECRET || '',

  // ---- CORS (GET-only) ----
  corsAllowedOrigins:
    process.env.CORS_ALLOWED_ORIGINS || 'https://confluencerclient.vercel.app',
};
