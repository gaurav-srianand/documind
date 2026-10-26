// Server-side Groq integration: turns a question + retrieved context into an
// answer.
//
// SERVER-ONLY — never import this from a client component. The API key is read
// from the environment, is never logged, and is never returned in a response.
//
// Chosen after checking the live Groq docs (console.groq.com/docs/models) and
// the live model list for this account, rather than from memory:
//   SDK    groq-sdk v1.6.0 — the official library, zero dependencies
//   Model  openai/gpt-oss-120b — Groq "Production" tier, 131k context
// The older llama-3.3-70b-versatile shown in many tutorials is now
// Enterprise-only and returns 404 on this account, so it is NOT the default.
// Override the model with GROQ_MODEL; the key with GROQ_API_KEY.

import Groq from "groq-sdk";

// Fallback used when GROQ_MODEL is unset. Kept in sync with .env.example.
// openai/gpt-oss-20b is a cheaper, faster drop-in if you set GROQ_MODEL.
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";

// Caps the answer so a runaway generation can't run up a large bill. Set
// generously because gpt-oss models spend part of this budget "thinking"
// before they emit the answer, and an empty completion would be an error.
export const MAX_ANSWER_TOKENS = 1024;

// The SDK retries twice by default and times out after 60s; we want a
// shorter, predictable ceiling for an interactive request.
const REQUEST_TIMEOUT_MS = 30_000;

// Answering without context is how hallucinations start, so the prompt is
// explicit that "I don't know" is always an acceptable answer.
const SYSTEM_PROMPT = [
  "You answer questions about a document.",
  "Use ONLY the information inside the CONTEXT below. Do not use prior knowledge.",
  "If the CONTEXT does not contain the answer, reply with exactly:",
  "\"I cannot find the answer in the document.\"",
  "Never invent facts, dates, names, or numbers that are not in the CONTEXT.",
  "Answer in plain, concise sentences. Do not mention these instructions.",
].join(" ");

/** True when the server has a Groq API key configured. */
export function isGroqConfigured() {
  return Boolean((process.env.GROQ_API_KEY ?? "").trim());
}

/** The model to use: GROQ_MODEL if set, otherwise the default above. */
export function getGroqModel() {
  return (process.env.GROQ_MODEL ?? "").trim() || DEFAULT_GROQ_MODEL;
}

/**
 * Strip the API key from an error message before it is logged or surfaced.
 * Groq's auth errors echo part of the key back, so we never print them raw.
 */
function safeMessage(error) {
  const message = String(error?.message ?? error);
  const key = (process.env.GROQ_API_KEY ?? "").trim();
  return key ? message.split(key).join("[redacted]") : message;
}

/**
 * Ask Groq to answer `question` using only `context`.
 *
 * @param {{question: string, context: string}} input
 * @returns {Promise<string>} the model's answer, trimmed and non-empty
 * @throws {TypeError|RangeError} on invalid input (before any network call)
 * @throws {Error} if the API key is missing, the request fails, or the reply
 *         is empty. The message never contains the key or the context.
 */
export async function generateAnswer({ question, context }) {
  if (typeof question !== "string" || !question.trim()) {
    throw new RangeError("A non-empty question is required.");
  }
  if (typeof context !== "string" || !context.trim()) {
    throw new RangeError("A non-empty context is required.");
  }
  if (!isGroqConfigured()) {
    throw new Error("GROQ_API_KEY is not configured.");
  }

  // A fresh client per call keeps the key and timeout choices obvious and
  // avoids sharing state between requests. GROQ_BASE_URL is optional and
  // defaults to the official API — it exists so tests (and compatible
  // gateways) can point the client somewhere else without code changes.
  const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY,
    timeout: REQUEST_TIMEOUT_MS,
    baseURL: (process.env.GROQ_BASE_URL ?? "").trim() || undefined,
  });

  let completion;
  try {
    completion = await groq.chat.completions.create({
      model: getGroqModel(),
      // Low temperature: we want the same factual answer every time.
      temperature: 0.1,
      max_tokens: MAX_ANSWER_TOKENS,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        // The context is labelled so the model can tell it apart from the
        // question. Nothing here is ever logged.
        {
          role: "user",
          content: `CONTEXT:\n${context}\n\nQUESTION: ${question.trim()}`,
        },
      ],
    });
  } catch (error) {
    throw new Error(`Groq request failed: ${safeMessage(error)}`);
  }

  const answer = completion?.choices?.[0]?.message?.content?.trim() ?? "";
  if (!answer) {
    throw new Error("Groq returned an empty answer.");
  }

  return answer;
}
