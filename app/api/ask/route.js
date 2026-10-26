import connectToDatabase from "@/lib/mongodb";
import Document from "@/models/Document";
import { generateEmbedding } from "@/lib/embeddings";
import { searchSimilarChunks } from "@/lib/chroma";
import { generateAnswer, isGroqConfigured } from "@/lib/groq";

// Longest question we accept. Anything longer is almost certainly a paste
// accident, and it keeps the embedding + Groq costs bounded.
const MAX_QUESTION_LENGTH = 2000;

// How many chunks we ask Chroma for and how many characters of text those
// chunks may contribute in total. No over-fetching is needed: the search is
// already scoped to a single document.
const MAX_CONTEXT_CHUNKS = 6;
const MAX_CONTEXT_CHARS = 8000;

// Document ids are MongoDB ObjectIds: 24 hex characters.
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

// Consistent JSON error shape, matching app/api/documents/route.js.
const errorResponse = (error, status) => Response.json({ error }, { status });

// Shown when the question simply has nothing to answer it. Deliberately does
// NOT call Groq — there is nothing for the model to work with.
const NO_CONTEXT_ANSWER =
  "I could not find anything in this document that answers that question.";

/**
 * Turn retrieved chunks into the text block we hand to Groq, stopping at the
 * character budget so one huge PDF cannot blow up the request.
 *
 * @returns {{context: string, included: Array}} the text and the chunks that
 *          actually made it in — citations are derived from `included`.
 */
function buildContext(chunks) {
  const parts = [];
  const included = [];
  let used = 0;

  for (const chunk of chunks) {
    const text = chunk.text.trim();
    const block = `[page ${chunk.pageNumber}, chunk ${chunk.chunkIndex}]\n${text}`;

    if (used + block.length > MAX_CONTEXT_CHARS) break;

    parts.push(block);
    included.push(chunk);
    used += block.length;
  }

  return { context: parts.join("\n\n"), included };
}

// One citation per (page, chunk), in nearest-first order, and only for chunks
// that were really sent to the model.
function buildCitations(included) {
  const seen = new Set();
  const citations = [];

  for (const chunk of included) {
    const key = `${chunk.pageNumber}:${chunk.chunkIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ pageNumber: chunk.pageNumber, chunkIndex: chunk.chunkIndex });
  }

  return citations;
}

// The system prompt tells the model to say "I cannot find the answer in the
// document." when the context is no help. Showing a page citation next to that
// reply would suggest the answer came from the page, so we drop the citations
// in that case. This is a deliberately loose match, not an exact one, because
// the model does not always phrase it identically.
const NO_ANSWER_PATTERN =
  /(cannot|could not|couldn't|can't|unable to)\s+(find|locate|determine|answer)/i;

// POST /api/ask  ->  answer a question about one indexed document
// Body: { "question": "...", "documentId": "..." }
export async function POST(request) {
  // ---- 1. Validate the request body ------------------------------------
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Request body must be valid JSON.", 400);
  }

  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) {
    return errorResponse("A non-empty question is required.", 400);
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return errorResponse(
      `Question must be ${MAX_QUESTION_LENGTH} characters or fewer.`,
      400
    );
  }

  const documentId =
    typeof body?.documentId === "string" ? body.documentId.trim() : "";
  if (!documentId) {
    return errorResponse("A non-empty documentId is required.", 400);
  }
  if (!OBJECT_ID_PATTERN.test(documentId)) {
    return errorResponse("documentId is not a valid document id.", 400);
  }

  try {
    // ---- 2. The document must exist ------------------------------------
    if (!process.env.MONGODB_URI) {
      return errorResponse("Server configuration error: database is not configured.", 500);
    }

    await connectToDatabase();
    const document = await Document.findById(documentId).select("filename status");
    if (!document) {
      return errorResponse("Document not found.", 404);
    }

    // ---- 3. Embed the question and search ChromaDB ----------------------
    let matches;
    try {
      const queryEmbedding = await generateEmbedding(question);
      // The documentId is passed down so Chroma filters by metadata itself.
      matches = await searchSimilarChunks(queryEmbedding, {
        documentId,
        limit: MAX_CONTEXT_CHUNKS,
      });
    } catch (error) {
      // Only the library's message is logged — never the question itself.
      console.error("[ask:POST] Retrieval failed:", error.message);
      return errorResponse("Could not search the document.", 500);
    }

    // ---- 4. Validate what came back ------------------------------------
    // Defense in depth: the query is already filtered by documentId, but we
    // still check the metadata rather than trusting the vector store. This
    // also drops any malformed rows.
    const chunks = matches
      .filter(
        (match) =>
          match.documentId === documentId &&
          typeof match.text === "string" &&
          match.text.trim() &&
          Number.isInteger(match.pageNumber) &&
          match.pageNumber > 0 &&
          Number.isInteger(match.chunkIndex) &&
          match.chunkIndex >= 0
      )
      .slice(0, MAX_CONTEXT_CHUNKS);

    // Nothing indexed (or nothing close enough to be worth sending). Answer
    // without calling Groq at all.
    if (chunks.length === 0) {
      return Response.json({ answer: NO_CONTEXT_ANSWER, citations: [] }, { status: 200 });
    }

    // ---- 5. Ask Groq to answer from that context only ------------------
    if (!isGroqConfigured()) {
      console.error("[ask:POST] GROQ_API_KEY is not set.");
      return errorResponse("Server configuration error: answer generation is not configured.", 500);
    }

    const { context, included } = buildContext(chunks);

    let answer;
    try {
      answer = await generateAnswer({ question, context });
    } catch (error) {
      // lib/groq.js already removes the API key from the message.
      console.error("[ask:POST] Answer generation failed:", error.message);
      return errorResponse("Could not generate an answer.", 500);
    }

    return Response.json(
      {
        answer,
        citations: NO_ANSWER_PATTERN.test(answer) ? [] : buildCitations(included),
      },
      { status: 200 }
    );
  } catch (error) {
    // Catch-all for unexpected failures. Only the message is logged.
    console.error("[ask:POST] Failed:", error.message);
    return errorResponse("Could not answer the question.", 500);
  }
}
