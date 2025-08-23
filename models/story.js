const mongoose = require('mongoose');

// Define a sub-schema for each section of the story. Each section
// contains the text to be read aloud, the corresponding audio file
// path, and the animation action. The action field is optional
// because some summaries may not specify one.
const SectionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    audio: { type: String, required: true },
    action: { type: String, default: null },
  },
  { _id: false }
);

// Define the main Story schema. A story has a title and an ordered
// list of sections. Timestamps are enabled so we can track when
// stories are created and updated.
const StorySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    sections: { type: [SectionSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Story', StorySchema);