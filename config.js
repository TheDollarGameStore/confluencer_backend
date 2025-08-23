// Configuration file for the summary TTS app.
// Switched from MEGA to Cloudinary for hosting mp3s.

require('dotenv').config();

module.exports = {
  // ---- Mongo ----
  mongoUri:
    process.env.MONGO_URI ||
    '',

  // ---- OpenAI (chat + TTS proxy) ----
  openAiChatApiKey: process.env.OPENAI_CHAT_API_KEY || '',
  openAiChatApiUrl: process.env.OPENAI_CHAT_URL || 'https://api.openai.com/v1',

  openAiTtsApiKey: process.env.OPENAI_TTS_API_KEY || 'NOT_REQUIRED',
  openAiTtsApiUrl: process.env.OPENAI_TTS_API_URL || 'http://localhost:8880/v1',

  summarisationPrompt:
    process.env.SUMMARISATION_PROMPT ||
    `You are a confluencer. An influencer who makes short form content to explain documentation on Confluence.
    You speak with humour and clickbait. You provide a rundown of an entire page being fed to you within 60 seconds.
    Provide me a script containing only the text that needs to be read out loud. No markdown, No parentheticals, stage directions, narrative asides, inline action cues or anything else.
    The first sentence you write is the title and it needs to be clickbait and catchy. It should also be short.
    Do not use new lines. Just continual sentences.
    Insert some jabs at typical corporate culture and red tape where appropriate.

    I'll provide you with text from a scraped website. Ignore irrelevant stuff like buttons etc. Summarize the important information only.
    
    The script should be structured as follows:
    
    "sentence": "sentence goes here"
    "action": "action name here"
    END_SENTENCE
    
    Repeat this for each sentence.
    
    At the end of all sentences, add the following:
    END_SUMMARY

    You decide what animation action to use. The actions you have available to you are the following:

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
    explaining3
    `,

  chatModel: process.env.CHAT_MODEL || 'gpt-5-mini',

  // ---- TTS model settings (your FastAPI or OpenAI passthrough) ----
  ttsModel: process.env.TTS_MODEL || 'kokoro',
  ttsVoice: process.env.TTS_VOICE || 'am_santa',
  ttsSpeed: parseFloat(process.env.TTS_SPEED) || 1.0,

  // Local scratch dir where we briefly write mp3s before uploading.
  audioDir: process.env.AUDIO_DIR || 'audio',

  // ---- Cloudinary ----
  // Folder to keep your uploads organized
  cloudinaryFolder: process.env.CLOUDINARY_FOLDER || 'confluencer-audio',
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  cloudApiKey: process.env.CLOUDINARY_API_KEY || '',
  cloudApiSecret: process.env.CLOUDINARY_API_SECRET || '',

  // ---- CORS (GET-only) ----
  corsAllowedOrigins:
    process.env.CORS_ALLOWED_ORIGINS || 'https://confluencerclient.vercel.app',
};
