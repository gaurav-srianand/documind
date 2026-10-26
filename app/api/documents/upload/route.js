import connectToDatabase from "@/lib/mongodb";
import Document from "@/models/Document";
import { extractPdfPages } from "@/lib/pdf";
import { chunkPages } from "@/lib/chunking";
import { generateEmbedding } from "@/lib/embeddings";
import { addDocumentChunks, deleteDocumentChunks } from "@/lib/chroma";

// Hard limit for a single uploaded file: 10 MB.
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Multipart bodies carry a little extra beyond the file itself (the boundary
// markers, field names, filename). We allow this much slack when we reject a
// request early based on its Content-Length header, so a legitimate 10 MB file
// is never turned away before we have even looked at it.
const MULTIPART_OVERHEAD = 64 * 1024;

// The PDF specification says the "%PDF-" header must appear within the first
// 1024 bytes of the file, so we only need to scan the beginning.
const PDF_HEADER_SCAN_BYTES = 1024;

// A PDF that produces fewer than this many non-whitespace characters counts as
// having no usable text (e.g. it is a scan of images). Tunable.
const MIN_EXTRACTED_CHARS = 10;

// Consistent JSON error shape, matching app/api/documents/route.js.
const errorResponse = (error, status) => Response.json({ error }, { status });

// Look for the literal "%PDF-" magic bytes near the start of the file.
// This is what actually proves a file is a PDF — a renamed .txt or a
// client-supplied MIME type can lie, but the bytes cannot.
function hasPdfMagicBytes(bytes) {
  const limit = Math.min(bytes.length, PDF_HEADER_SCAN_BYTES) - 4;
  for (let i = 0; i < limit; i++) {
    const isMagic =
      bytes[i] === 0x25 && // %
      bytes[i + 1] === 0x50 && // P
      bytes[i + 2] === 0x44 && // D
      bytes[i + 3] === 0x46 && // F
      bytes[i + 4] === 0x2d; // -
    if (isMagic) return true;
  }
  return false;
}

// POST /api/documents/upload  ->  upload a PDF, extract, chunk, embed, index
// The document only becomes "ready" once all of its chunks are in ChromaDB.
export async function POST(request) {
  // ---- 1. Reject oversized requests before reading the body -------------
  // The Content-Length header tells us the size up front, so we can turn a
  // huge upload away without buffering it into memory first.
  const contentLength = Number(request.headers.get("content-length"));
  const maxRequest = MAX_FILE_SIZE + MULTIPART_OVERHEAD;

  if (Number.isFinite(contentLength) && contentLength > maxRequest) {
    console.error("[documents:upload] Rejected by content-length gate:", contentLength);
    return errorResponse(`File is too large. Maximum size is 10 MB.`, 413);
  }

  try {
    // ---- 2. Parse the multipart form ---------------------------------
    let formData;
    try {
      formData = await request.formData();
    } catch {
      // A body that isn't valid multipart/form-data throws here.
      return errorResponse("Request body must be valid multipart/form-data.", 400);
    }

    const file = formData.get("file");

    // formData.get() returns a File, a plain string, or null. Anything that
    // isn't a File means the caller did not send a file under "file".
    if (!file || typeof file === "string") {
      return errorResponse('A PDF file is required in the "file" field.', 400);
    }

    if (file.size === 0) {
      return errorResponse("File is empty. Please upload a non-empty PDF.", 400);
    }

    // ---- 3. Enforce the size limit precisely --------------------------
    // Content-Length is optional, so this is the authoritative check. It also
    // catches a 10 MB file plus a few KB of multipart framing.
    if (file.size > MAX_FILE_SIZE) {
      console.error("[documents:upload] Rejected by size check:", file.size);
      return errorResponse("File is too large. Maximum size is 10 MB.", 413);
    }

    // Safe from here on: the file is at most 10 MB.
    const bytes = new Uint8Array(await file.arrayBuffer());

    if (!hasPdfMagicBytes(bytes)) {
      return errorResponse(
        "This file is not a PDF. The file content does not start with a PDF signature.",
        415
      );
    }

    // ---- 4. Extract text using the existing utility --------------------
    let pages;
    try {
      pages = await extractPdfPages(bytes);
    } catch (error) {
      // Corrupt or password-protected files land here. We log the library's
      // message privately and return a generic, safe explanation.
      console.error("[documents:upload] PDF parse failed:", error.message);
      return errorResponse(
        "Could not parse this PDF. The file may be corrupted, incomplete, or password-protected.",
        415
      );
    }

    // ---- 5. Reject PDFs with no usable text ---------------------------
    const extractedChars = pages.reduce(
      (total, page) => total + page.text.replace(/\s/g, "").length,
      0
    );

    if (pages.length === 0 || extractedChars < MIN_EXTRACTED_CHARS) {
      return errorResponse(
        "No extractable text was found in this PDF. Scanned or image-only PDFs are not supported yet.",
        422
      );
    }

    // ---- 6. Save metadata (never the PDF bytes or extracted text) ------
    if (!process.env.MONGODB_URI) {
      // Checked separately so we can say "configuration is missing" instead of
      // returning a generic failure. The message contains no secrets.
      return errorResponse("Server configuration error: database is not configured.", 500);
    }

    await connectToDatabase();

    // Keep only a safe base filename: strip any path a client may have sent.
    const filename =
      file.name.split(/[\\/]/).pop()?.trim().slice(0, 255) || "uploaded.pdf";

    // The record starts out "processing" and only becomes "ready" once every
    // chunk has been embedded and stored, so a half-finished document is
    // never presented as usable. pageCount is already known from extraction.
    const document = await Document.create({
      filename,
      status: "processing",
      pageCount: pages.length,
    });

    // ChromaDB keys everything off the Mongo id, so the two stores always
    // point at the same document.
    const documentId = document._id.toString();

    // ---- 7. Chunk -> embed -> store, then mark the document ready ------
    // Anything that fails from here on is turned into a definite terminal
    // state: chunks are cleaned up and the record is marked "failed".
    try {
      const chunks = chunkPages(pages);

      // The character check above should make this unreachable, but we guard
      // so an unusable document can never be marked "ready".
      if (chunks.length === 0) {
        throw new Error("Chunking produced no chunks for this PDF.");
      }

      // Embed one chunk at a time. Never log the chunk text or the vectors.
      const embeddedChunks = [];
      for (const chunk of chunks) {
        embeddedChunks.push({
          ...chunk,
          embedding: await generateEmbedding(chunk.text),
        });
      }

      await addDocumentChunks(documentId, embeddedChunks);

      // Only now is the document actually searchable.
      await Document.updateOne({ _id: document._id }, { status: "ready" });
      document.status = "ready"; // keep the response in sync with the database
    } catch (error) {
      // Log the library's message privately; the client gets a fixed string.
      console.error("[documents:upload] Processing failed:", error.message);

      // Best-effort cleanup: drop any chunks we did manage to store, so a
      // failed document leaves no searchable fragments behind.
      try {
        await deleteDocumentChunks(documentId);
      } catch (cleanupError) {
        console.error(
          "[documents:upload] Chroma cleanup failed:",
          cleanupError.message
        );
      }

      // And leave the record in an honest terminal state.
      try {
        await Document.updateOne({ _id: document._id }, { status: "failed" });
      } catch (statusError) {
        console.error(
          "[documents:upload] Could not mark document failed:",
          statusError.message
        );
      }

      return errorResponse("Could not process the uploaded document.", 500);
    }

    // 201 = Created. Explicit response shape: id, filename, pageCount, status.
    return Response.json(
      {
        id: document._id.toString(),
        filename: document.filename,
        pageCount: document.pageCount,
        status: document.status,
      },
      { status: 201 }
    );
  } catch (error) {
    // Catch-all for database and other unexpected failures. Only the message
    // is logged on the server; the client gets a fixed, non-revealing string.
    console.error("[documents:upload] Failed:", error.message);
    return errorResponse("Could not save document", 500);
  }
}
