const mongoose = require('mongoose');

// Each section stores the TTS text, the B2 object key (required),
// and an optional action cue. 'audio' is kept optional for legacy docs.
const SectionSchema = new mongoose.Schema(
  {
    text:   { type: String, required: true },
    key:    { type: String, required: true },  // B2 object key (e.g., "uuid.mp3")
    action: { type: String, default: null },

    // Legacy: older docs may have persisted a public URL.
    // Kept optional; your GET route now presigns from 'key'.
    audio:  { type: String, required: false },
  },
  { _id: false }
);

// Story with a title and ordered list of sections.
// Timestamps so you can sort by createdAt/updatedAt if needed.
const StorySchema = new mongoose.Schema(
  {
    title:    { type: String, required: true },
    sections: { type: [SectionSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Story', StorySchema);
