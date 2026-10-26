/** @type {import('next').NextConfig} */
const nextConfig = {
  // pdfjs-dist resolves some of its files (worker + parsing code) at runtime.
  // Next.js otherwise tries to bundle it, which can break on the server.
  // Externalizing keeps Node loading it the normal way.
  //
  // chromadb dynamically imports "@chroma-core/default-embed", which we do not
  // install; if Next bundled it, it would try to resolve that missing package.
  // (@huggingface/transformers and onnxruntime-node are already externalized
  // by Next's built-in list, so they don't need to appear here.)
  serverExternalPackages: ["pdfjs-dist", "chromadb"],
};

module.exports = nextConfig;
