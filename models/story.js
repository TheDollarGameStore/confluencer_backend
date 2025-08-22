const mongoose = require('mongoose');

// Define the schema for a single section of a story. Each section
// represents one sentence from the summary along with a link to the
// generated audio file. Storing the audio link as a simple string
// preserves flexibility – you can serve static files from the same
// server or point to an external storage service such as S3 later on.
const SectionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    audio: { type: String, required: true }
  },
  { _id: false }
);

// Stories consist of a title and an ordered list of sections. The
// `sections` field is an array of SectionSchema objects. Mongoose will
// enforce the defined structure when saving documents to the
// collection.
const StorySchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    sections: { type: [SectionSchema], required: true }
  },
  { timestamps: true }
);

// Export the model. Mongoose will create a collection called
// `stories` in the configured database. When using this model, call
// `Story.create()` or `new Story()` to insert documents.
module.exports = mongoose.model('Story', StorySchema);