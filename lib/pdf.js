// The "legacy" build is the one PDF.js officially supports under Node.js.
// In Node we don't configure a worker — PDF.js falls back to the main thread.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * Extract text from a PDF, page by page.
 *
 * @param {Uint8Array | ArrayBuffer | Buffer} pdfBytes - raw PDF file bytes
 * @returns {Promise<Array<{ pageNumber: number, text: string }>>}
 *          one entry per page, e.g. [{ pageNumber: 1, text: "..." }]
 */
export async function extractPdfPages(pdfBytes) {
  // pdfjs-dist 6 rejects Node Buffer objects outright. Buffer *extends*
  // Uint8Array, so a plain `instanceof Uint8Array` check would wrongly let it
  // through — we must detect Buffer specifically and convert it.
  const isNodeBuffer =
    typeof Buffer !== "undefined" && pdfBytes instanceof Buffer;

  // Anything that isn't already a plain Uint8Array gets converted into one.
  // (new Uint8Array(buffer) copies the bytes into a fresh, non-Buffer array;
  //  new Uint8Array(arrayBuffer) wraps the raw ArrayBuffer.)
  const data =
    pdfBytes instanceof Uint8Array && !isNodeBuffer
      ? pdfBytes
      : new Uint8Array(pdfBytes);

  const loadingTask = getDocument({
    data,
    useSystemFonts: true, // fall back to built-in fonts when none are embedded
    isEvalSupported: false, // safer default; we never need eval()
    // We only extract text on the server, never render to an image.
    // Turning font-face setup off avoids canvas-only code paths in Node.
    disableFontFace: true,
  });

  // parsing only happens once .promise resolves
  const pdf = await loadingTask.promise;
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();

      // Each "item" may or may not carry a string. We keep only the string
      // ones and join with spaces. Scanned/image-only pages yield no strings,
      // so their text is an empty string — handled gracefully, not an error.
      const text = content.items
        .filter((item) => "str" in item)
        .map((item) => item.str)
        .join(" ")
        .trim();

      pages.push({ pageNumber, text });

      // Free this page's resources before moving to the next one.
      page.cleanup();
    }
  } finally {
    // Always tear down, even if a page failed, so we don't leak memory
    // across many uploads. In pdfjs-dist 6 the *loading task* owns teardown
    // (PDFDocumentProxy has no destroy() method).
    await loadingTask.destroy();
  }

  return pages;
}
