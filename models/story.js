const mongoose = require('mongoose');

const SectionSchema = new mongoose.Schema(
  {
    text:   { type: String, required: true },
    key:    { type: String, required: true },  // public mp3 URL
    action: { type: String, default: null },

    // Legacy carry-over
    audio:  { type: String, required: false },
  },
  { _id: false }
);

// New schema: store per-persona sections separately.
// Keep legacy "sections" for back-compat and migration during reads.
const StorySchema = new mongoose.Schema(
  {
    title:           { type: String, required: true },
    sectionsBrain:   { type: [SectionSchema], default: [] },
    sectionsGirl:    { type: [SectionSchema], default: [] },
    sectionsFinancer:{ type: [SectionSchema], default: [] }, // NEW

    sourceUrl:       { type: String, default: null },
  },
  { timestamps: true }
);


module.exports = mongoose.model('Story', StorySchema);
