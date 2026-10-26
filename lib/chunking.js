// Pure text-chunking utility for the future RAG pipeline.
//
// This file deliberately has NO imports: it must stay independent of Next.js,
// MongoDB, PDF.js, embeddings, and external APIs so it can be reasoned about
// and tested in isolation. Input is the output of extractPdfPages():
// an array of { pageNumber, text }.

const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 150;

// Options must be whole numbers; anything else (strings, floats, NaN) is a bug
// in the caller and should fail loudly rather than produce odd chunks.
function assertIntegerOption(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(
      `${name} must be an integer, received ${JSON.stringify(value)}.`
    );
  }
}

/**
 * Split page text into overlapping, character-sized chunks.
 *
 * @param {Array<{ pageNumber: number, text: string }>} pages
 * @param {{ chunkSize?: number, overlap?: number }} [options]
 * @returns {Array<{ pageNumber: number, chunkIndex: number, text: string }>}
 */
export function chunkPages(pages, options = {}) {
  if (!Array.isArray(pages)) {
    throw new TypeError("pages must be an array of { pageNumber, text } objects.");
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object when provided.");
  }

  // `??` keeps an explicit 0 (which should be rejected below), unlike `||`.
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  assertIntegerOption(chunkSize, "chunkSize");
  assertIntegerOption(overlap, "overlap");

  if (chunkSize <= 0) {
    throw new RangeError("chunkSize must be greater than 0.");
  }
  if (overlap < 0) {
    throw new RangeError("overlap must be 0 or greater.");
  }
  if (overlap >= chunkSize) {
    throw new RangeError("overlap must be smaller than chunkSize.");
  }

  const chunks = [];

  for (const page of pages) {
    const pageNumber = page?.pageNumber;
    const rawText = typeof page?.text === "string" ? page.text : "";
    const text = rawText.trim();

    // Skip pages with no meaningful text: blank, whitespace-only, or a scanned
    // page where extraction produced nothing.
    if (!text) continue;

    let start = 0;
    let chunkIndex = 0;

    while (start < text.length) {
      const end = Math.min(start + chunkSize, text.length);
      const chunkText = text.slice(start, end).trim();

      // Whitespace-only windows are dropped rather than returned empty. Its
      // index is not consumed, so the returned indexes stay 0,1,2,... per page.
      if (chunkText) {
        chunks.push({ pageNumber, chunkIndex, text: chunkText });
        chunkIndex += 1;
      }

      // Stop once this window reached the end of the page. Otherwise the next
      // window starts (chunkSize - overlap) characters later, which is always
      // positive because overlap < chunkSize. That guarantees forward progress
      // and makes an infinite loop impossible.
      //
      // Overlap rule: the next window re-reads the final `overlap` characters
      // of this one (after trimming), so context is never lost at a boundary.
      if (end >= text.length) break;
      start = end - overlap;
    }
  }

  return chunks;
}
