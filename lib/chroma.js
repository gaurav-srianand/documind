// Local ChromaDB (vector database) integration for DocuMind's RAG pipeline.
//
// SERVER-ONLY — never import this from a client component. It talks to a
// Chroma server over HTTP; no credentials are involved for local use.
//
// How the pieces fit together (each lives in its own module):
//   lib/pdf.js        PDF bytes   -> [{ pageNumber, text }]
//   lib/chunking.js   pages       -> [{ pageNumber, chunkIndex, text }]
//   lib/embeddings.js text        -> number[] of length 384
//   lib/chroma.js     (this file) stores those vectors and searches them
//
// This module NEVER generates embeddings. Callers pass them in, so Chroma
// never has to run an embedding model of its own.
//
// ── Expected ChromaDB setup (not running by default) ──────────────────────
// Connection comes from .env / .env.example:
//   CHROMA_HOST=localhost   CHROMA_PORT=8000   CHROMA_COLLECTION=documind
// Expected URL: http://localhost:8000
//
// Start a local server with Docker (data survives restarts via a volume):
//   docker run --rm -p 8000:8000 -v ./chroma-data:/chroma/chroma chromadb/chroma
//
// If ChromaDB is not running, every function here fails with an error that
// says so and repeats the command above.

import { ChromaClient, ChromaConnectionError } from "chromadb";

// Single source of truth for the vector size; kept in lib/embeddings.js so a
// change to the model can never drift out of sync with what we store.
import { EMBEDDING_DIM } from "./embeddings.js";

// How many matches searchSimilarChunks returns unless the caller overrides it.
export const DEFAULT_SEARCH_LIMIT = 5;

// Upper bound so a caller can't accidentally ask for the whole collection.
export const MAX_SEARCH_LIMIT = 50;

// Longest documentId we accept (MongoDB ids are 24 characters).
const MAX_DOCUMENT_ID_LENGTH = 200;

// ── configuration ─────────────────────────────────────────────────────────

// Read connection settings from the environment on every call, so tests can
// point the client at a different server without re-importing the module.
function getSettings() {
  const host = (process.env.CHROMA_HOST ?? "").trim() || "localhost";
  const port = Number(process.env.CHROMA_PORT ?? 8000);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CHROMA_PORT must be a whole number between 1 and 65535.");
  }

  const collection = (process.env.CHROMA_COLLECTION ?? "").trim() || "documind";

  return { host, port, collection, url: `http://${host}:${port}` };
}

// ── validation ────────────────────────────────────────────────────────────

function assertDocumentId(documentId) {
  if (typeof documentId !== "string") {
    throw new TypeError(`documentId must be a string, received ${typeof documentId}.`);
  }

  const id = documentId.trim();

  if (!id) {
    throw new RangeError("documentId must be a non-empty string.");
  }
  if (id.length > MAX_DOCUMENT_ID_LENGTH) {
    throw new RangeError(`documentId must be ${MAX_DOCUMENT_ID_LENGTH} characters or fewer.`);
  }

  return id;
}

function assertEmbedding(embedding, label) {
  if (!Array.isArray(embedding)) {
    throw new TypeError(`${label} must be an array, received ${typeof embedding}.`);
  }

  if (embedding.length !== EMBEDDING_DIM) {
    throw new RangeError(
      `${label} must contain exactly ${EMBEDDING_DIM} numbers, received ${embedding.length}.`
    );
  }

  if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new TypeError(`${label} must contain only finite numbers.`);
  }

  return embedding;
}

function assertLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new RangeError(
      `limit must be a whole number between 1 and ${MAX_SEARCH_LIMIT}, received ${JSON.stringify(limit)}.`
    );
  }
}

// Turn caller-supplied chunks into Chroma records. Validation happens HERE,
// before any network call, so bad input fails fast without needing a server.
function buildRecords(documentId, chunks) {
  if (!Array.isArray(chunks)) {
    throw new TypeError(`chunks must be an array, received ${typeof chunks}.`);
  }
  if (chunks.length === 0) {
    throw new RangeError("chunks must contain at least one chunk.");
  }

  return chunks.map((chunk, index) => {
    if (chunk === null || typeof chunk !== "object") {
      throw new TypeError(`chunks[${index}] must be an object.`);
    }

    const text = typeof chunk.text === "string" ? chunk.text.trim() : "";
    if (!text) {
      throw new RangeError(`chunks[${index}].text must be a non-empty string.`);
    }

    if (!Number.isInteger(chunk.pageNumber) || chunk.pageNumber < 1) {
      throw new RangeError(`chunks[${index}].pageNumber must be a whole number of 1 or more.`);
    }

    if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0) {
      throw new RangeError(`chunks[${index}].chunkIndex must be a whole number of 0 or more.`);
    }

    assertEmbedding(chunk.embedding, `chunks[${index}].embedding`);

    // Deterministic id: re-uploading the same document replaces its chunks
    // instead of creating duplicates.
    return {
      id: `${documentId}:${chunk.pageNumber}:${chunk.chunkIndex}`,
      text,
      embedding: chunk.embedding,
      metadata: {
        documentId,
        pageNumber: chunk.pageNumber,
        chunkIndex: chunk.chunkIndex,
      },
    };
  });
}

// ── error handling ────────────────────────────────────────────────────────

// Build a useful but safe error. Only `error.message` is forwarded (never a
// stack trace, and never any document text or query text).
function toChromaError(error, action) {
  const { url, port } = getSettings();

  if (error instanceof ChromaConnectionError) {
    return new Error(
      `ChromaDB is unavailable — no response from ${url}. ` +
        `Start the local server with:\n` +
        `  docker run --rm -p ${port}:${port} -v ./chroma-data:/chroma/chroma chromadb/chroma`
    );
  }

  return new Error(`ChromaDB ${action}: ${error.message}`);
}

// ── connection (lazy, reused) ─────────────────────────────────────────────

let collectionPromise = null;

function getCollection() {
  if (!collectionPromise) {
    collectionPromise = openCollection().catch((error) => {
      // Drop the failed attempt so the next call retries once the server is up.
      collectionPromise = null;
      throw error;
    });
  }

  return collectionPromise;
}

async function openCollection() {
  const { host, port, collection } = getSettings();
  const client = new ChromaClient({ host, port });

  try {
    // `embeddingFunction: null` is the important part: it tells Chroma "we
    // supply the vectors ourselves", so it never tries to load a model of its
    // own (the default one requires an extra package we deliberately don't
    // install). See processCreateCollectionConfig in the chromadb source.
    return await client.getOrCreateCollection({ name: collection, embeddingFunction: null });
  } catch (error) {
    throw toChromaError(error, `could not open collection "${collection}"`);
  }
}

// ── public API ────────────────────────────────────────────────────────────

/**
 * Store chunks (plus their embeddings) for one document.
 *
 * Each chunk needs: `{ pageNumber, chunkIndex, text, embedding }` — i.e. the
 * output of `chunkPages()` with an `embedding` added from `generateEmbedding()`.
 * The chunk text is stored as Chroma's `document`; embeddings are stored as-is.
 *
 * Re-running for the same documentId is safe: existing chunks are replaced.
 *
 * @param {string} documentId - unique id of the document these chunks belong to
 * @param {Array<{pageNumber: number, chunkIndex: number, text: string, embedding: number[]}>} chunks
 * @returns {Promise<number>} how many chunks were stored
 * @throws {TypeError|RangeError} on invalid input (before any network call)
 * @throws {Error} if ChromaDB is unreachable or rejects the write
 */
export async function addDocumentChunks(documentId, chunks) {
  const id = assertDocumentId(documentId);
  const records = buildRecords(id, chunks);

  const collection = await getCollection();

  try {
    // upsert (not add) so a re-index of the same document doesn't fail on
    // duplicate ids.
    await collection.upsert({
      ids: records.map((record) => record.id),
      embeddings: records.map((record) => record.embedding),
      documents: records.map((record) => record.text),
      metadatas: records.map((record) => record.metadata),
    });
  } catch (error) {
    throw toChromaError(error, "could not store the document's chunks");
  }

  return records.length;
}

/**
 * Find the chunks most similar to a query embedding **within one document**.
 *
 * The document filter is applied by Chroma itself (`where`), not after the
 * fact, so chunks from other documents never enter the result set — even when
 * they are more similar to the query. `documentId` is required: there is no
 * "search everything" mode, which keeps cross-document leakage impossible.
 *
 * Results are ordered nearest-first (`distance` is smaller = closer).
 * The query text itself is never logged or echoed back in an error.
 *
 * @param {number[]} queryEmbedding - a vector from `generateEmbedding()`
 * @param {{documentId: string, limit?: number}} options - `documentId` is
 *        required; `limit` defaults to DEFAULT_SEARCH_LIMIT
 * @returns {Promise<Array<{id, text, documentId, pageNumber, chunkIndex, distance}>>}
 * @throws {TypeError|RangeError} on invalid input (before any network call)
 * @throws {Error} if ChromaDB is unreachable or the query fails
 */
export async function searchSimilarChunks(queryEmbedding, options = {}) {
  assertEmbedding(queryEmbedding, "queryEmbedding");

  const documentId = assertDocumentId(options?.documentId);

  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
  assertLimit(limit);

  const collection = await getCollection();

  let result;
  try {
    result = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      // Restrict the vector search to this document's chunks. `delete` already
      // uses this exact `{ where: { documentId: { $eq } } }` shape.
      where: { documentId: { $eq: documentId } },
      // Deliberately no "embeddings" here: we don't need the vectors back.
      include: ["documents", "metadatas", "distances"],
    });
  } catch (error) {
    throw toChromaError(error, "could not run the similarity search");
  }

  // Chroma returns one nested array per query; we only ever run one query.
  const ids = result?.ids?.[0] ?? [];
  const documents = result?.documents?.[0] ?? [];
  const metadatas = result?.metadatas?.[0] ?? [];
  const distances = result?.distances?.[0] ?? [];

  return ids.map((id, index) => {
    const metadata = metadatas[index] ?? {};
    return {
      id,
      text: documents[index] ?? "",
      documentId: typeof metadata.documentId === "string" ? metadata.documentId : null,
      pageNumber: typeof metadata.pageNumber === "number" ? metadata.pageNumber : null,
      chunkIndex: typeof metadata.chunkIndex === "number" ? metadata.chunkIndex : null,
      distance: typeof distances[index] === "number" ? distances[index] : null,
    };
  });
}

/**
 * Delete every chunk belonging to one document.
 *
 * @param {string} documentId
 * @returns {Promise<number>} how many chunks were deleted
 * @throws {TypeError|RangeError} on invalid input
 * @throws {Error} if ChromaDB is unreachable or the delete fails
 */
export async function deleteDocumentChunks(documentId) {
  const id = assertDocumentId(documentId);

  const collection = await getCollection();

  try {
    const result = await collection.delete({ where: { documentId: { $eq: id } } });
    return result?.deleted ?? 0;
  } catch (error) {
    throw toChromaError(error, "could not delete the document's chunks");
  }
}
