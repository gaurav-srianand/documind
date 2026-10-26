import mongoose from "mongoose";

const DocumentSchema = new mongoose.Schema(
  {
    // The original filename of the uploaded PDF, e.g. "syllabus.pdf".
    filename: { type: String, required: true },

    // Where this PDF is in the upload/processing pipeline.
    // "processing" = still extracting/embedding, "ready" = usable,
    // "failed" = something went wrong.
    status: {
      type: String,
      enum: ["processing", "ready", "failed"],
      default: "processing",
    },

    // Total pages in the PDF. We keep it at 0 until extraction finishes.
    pageCount: { type: Number, default: 0, min: 0 },
  },
  // timestamps: true lets Mongoose auto-create and auto-update
  // createdAt and updatedAt on every save, so we don't declare them here.
  { timestamps: true }
);

// Guard against OverwriteModelError: Next.js hot-reloading can evaluate
// this module multiple times, and re-registering the model throws.
const Document =
  mongoose.models.Document || mongoose.model("Document", DocumentSchema);

export default Document;
