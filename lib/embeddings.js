// Local, server-side text embeddings for the future RAG pipeline.
//
// Everything here runs in-process with ONNX Runtime (onnxruntime-node). The
// only network access is the one-time download of the model weights from the
// Hugging Face Hub; after that the model is cached on disk. The text you pass
// in is NEVER sent anywhere — inference happens locally.
//
// Uses @huggingface/transformers (Transformers.js v4), which ships a Node
// build (`transformers.node.mjs`) and a `feature-extraction` pipeline.

import { pipeline } from "@huggingface/transformers";

// Model verified against the shipped package docs and the Hugging Face Hub.
// It is the ONNX export of sentence-transformers/all-MiniLM-L6-v2: English,
// fast, and small — a standard choice for retrieval-style embeddings.
export const EMBEDDING_MODEL = "onnx-community/all-MiniLM-L6-v2-ONNX";

// The vector dimension this model always produces (verified from the package
// docs: the pooled output has dims [1, 384]).
export const EMBEDDING_DIM = 384;

// Loaded lazily on the first call and reused for every subsequent call.
// Keeping a single pipeline alive avoids re-initializing the model (and
// re-downloading / re-reading ~90 MB of weights) for each chunk.
let extractorPromise = null;

/**
 * Turn a piece of text into a numeric vector (an embedding).
 *
 * @param {string} text - non-empty text to embed
 * @returns {Promise<number[]>} a vector of length EMBEDDING_DIM with finite numbers
 * @throws {TypeError} if `text` is not a string
 * @throws {RangeError} if `text` is empty or only whitespace
 * @throws {Error} if the model cannot be loaded or inference fails
 */
export async function generateEmbedding(text) {
  if (typeof text !== "string") {
    throw new TypeError(`text must be a string, received ${typeof text}.`);
  }

  // Match the chunker: treat surrounding whitespace as insignificant.
  const input = text.trim();
  if (!input) {
    throw new RangeError("Cannot generate an embedding for empty text.");
  }

  // ---- 1. Load the model once (lazy), reuse across calls ----------------
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", EMBEDDING_MODEL);
  }

  let extractor;
  try {
    extractor = await extractorPromise;
  } catch (error) {
    // Reset so a transient failure (e.g. offline first run) can be retried.
    extractorPromise = null;
    // Only the message is surfaced; the input text is never logged or echoed.
    throw new Error(`Embedding model could not be loaded: ${error.message}`);
  }

  // ---- 2. Run inference -------------------------------------------------
  let vector;
  try {
    // pooling: "mean"  -> collapse per-token states into one vector.
    // normalize: true  -> unit length, so cosine similarity == dot product.
    const tensor = await extractor(input, {
      pooling: "mean",
      normalize: true,
    });
    vector = Array.from(tensor.data ?? []);
  } catch (error) {
    throw new Error(`Embedding inference failed: ${error.message}`);
  }

  // ---- 3. Sanity-check the result --------------------------------------
  if (vector.length === 0 || !vector.every(Number.isFinite)) {
    throw new Error("Embedding inference produced an invalid vector.");
  }

  return vector;
}
