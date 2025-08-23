// Configuration file for the summary TTS app.
//
// This module centralises all configurable values such as OpenAI API keys,
// the summarisation prompt and MongoDB connection details. When deploying
// or running the service locally, you can either set the corresponding
// environment variables or edit the values below directly. It is
// recommended to use environment variables for sensitive credentials.

require('dotenv').config();

module.exports = {
  // MongoDB connection string. Use a MongoDB Atlas URI with a user and
  // password that has permission to insert and query documents. Example:
  // mongodb+srv://username:password@cluster.mongodb.net/database?retryWrites=true&w=majority
  mongoUri: process.env.MONGO_URI || '',

  // Configuration for the OpenAI client used for chat completions. This key
  // should have access to the models you intend to use for summarisation
  // (e.g. gpt-4o or gpt-3.5-turbo). See the OpenAI documentation for the
  // available models. You can also set the model below in code.
  openAiChatApiKey: process.env.OPENAI_CHAT_API_KEY || '',
  openAiChatApiUrl: process.env.OPENAI_CHAT_URL || 'https://api.openai.com/v1',

  // Configuration for the OpenAI TTS endpoint. In many cases the same API
  // key can be used for both chat and audio endpoints; however, OpenAI
  // recommends using separate keys for better isolation and quota control.
  openAiTtsApiKey: process.env.OPENAI_TTS_API_KEY || 'NOT_REQUIRED',
  openAiTtsApiUrl: process.env.OPENAI_TTS_API_URL || 'http://localhost:8880/v1',

  // The prompt that instructs the chat model how to perform summarisation.
  // You can override this with an environment variable called
  // SUMMARISATION_PROMPT. A good starting point is:
  // "You are a helpful assistant that generates a concise summary and title
  //  for the provided text. Your response should be plain text without
  //  markdown."
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

  // Default model used for chat completions. Update this to a model your
  // account has access to (e.g. "gpt-4o", "gpt-3.5-turbo").
  chatModel: process.env.CHAT_MODEL || 'gpt-5-mini',

  // Voice and model for the TTS endpoint. See the OpenAI docs for
  // available voices: alloy, echo, fable, onyx, nova, shimmer, etc. The
  // model tts-1-hd produces higher fidelity audio at the cost of tokens.
  ttsModel: process.env.TTS_MODEL || 'kokoro',
  ttsVoice: process.env.TTS_VOICE || 'am_santa',
  ttsSpeed: parseFloat(process.env.TTS_SPEED) || 1.0,

  // The directory where generated audio files will be saved. This should
  // exist relative to the project root. The server exposes it as a
  // static path under /audio so clients can fetch mp3 files directly.
  audioDir: process.env.AUDIO_DIR || 'audio'
};