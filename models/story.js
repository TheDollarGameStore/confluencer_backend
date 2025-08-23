const mongoose = require('mongoose');

// Each section stores the TTS text, the B2/Cloudinary key (required),
// and an optional action cue. 'audio' is kept optional for legacy docs.
const SectionSchema = new mongoose.Schema(
  {
    text:   { type: String, required: true },
    key:    { type: String, required: true },  // public mp3 URL or object key
    action: { type: String, default: null },

    // Legacy: older docs may have persisted a public URL.
    audio:  { type: String, required: false },
  },
  { _id: false }
);

// Story with a title and ordered list of sections.
// Add sourceUrl to remember the input page used to generate this story.
const StorySchema = new mongoose.Schema(
  {
    title:     { type: String, required: true },
    sections:  { type: [SectionSchema], default: [] },
    sourceUrl: { type: String, default: null },   // <-- NEW
  },
  { timestamps: true }
);

module.exports = mongoose.model('Story', StorySchema);
