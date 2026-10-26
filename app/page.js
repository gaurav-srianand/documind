'use client';

import { useState, useEffect, useRef } from "react";

function formatDate(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString();
  } catch {
    return "-";
  }
}

export default function Home() {
  const [documents, setDocuments] = useState([]);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [docsError, setDocsError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedDoc, setSelectedDoc] = useState(null);

  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState("");
  const [uploadError, setUploadError] = useState("");

  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState("");
  const [answer, setAnswer] = useState("");
  const [citations, setCitations] = useState([]);
  const fileInputRef = useRef(null);

  async function fetchDocuments() {
    setLoadingDocs(true);
    setDocsError("");
    try {
      const res = await fetch("/api/documents");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Failed to load documents (${res.status})`);
      }
      const data = await res.json();
      setDocuments(Array.isArray(data) ? data : []);
      if (selectedId) {
        const cur = (Array.isArray(data) ? data : []).find((d) => d._id === selectedId || d.id === selectedId);
        setSelectedDoc(cur || null);
      }
    } catch (e) {
      setDocsError(e.message);
    } finally {
      setLoadingDocs(false);
    }
  }

  useEffect(() => {
    fetchDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelect(e) {
    const id = e.target.value;
    setSelectedId(id);
    const cur = documents.find((d) => d._id === id || d.id === id);
    setSelectedDoc(cur || null);
    setAnswer("");
    setCitations([]);
    setAskError("");
  }

  async function handleUpload(e) {
    e.preventDefault();
    setUploadError("");
    setUploadMsg("");
    if (!file) {
      setUploadError("Please choose a PDF file.");
      return;
    }
    if (file.size === 0) {
      setUploadError("File is empty.");
      return;
    }
    if (file.type && file.type !== "application/pdf") {
      setUploadError("Only PDF files are accepted.");
    }
    const form = new FormData();
    form.append("file", file);
    setUploading(true);
    try {
      const res = await fetch("/api/documents/upload", {
        method: "POST",
        body: form,
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j.error || `Upload failed (${res.status})`);
      }
      setUploadMsg(`Uploaded: ${j.filename} (${j.pageCount} pages) — ${j.status}`);
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      await fetchDocuments();
      if (j.id) {
        setSelectedId(j.id);
        const cur = documents.find((d) => (d._id === j.id || d.id === j.id)) || { _id: j.id, id: j.id, filename: j.filename, pageCount: j.pageCount, status: j.status };
        setSelectedDoc(cur);
      }
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleAsk(e) {
    e.preventDefault();
    setAskError("");
    setAnswer("");
    setCitations([]);
    if (!selectedId) {
      setAskError("Select a document first.");
      return;
    }
    if (selectedDoc && selectedDoc.status !== "ready") {
      setAskError("Selected document is not ready. Please wait for it to finish processing.");
      return;
    }
    const q = question.trim();
    if (!q) {
      setAskError("Enter a question.");
      return;
    }
    if (q.length > 2000) {
      setAskError("Question must be 2000 characters or fewer.");
      return;
    }
    setAsking(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: q, documentId: selectedId }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(j.error || `Request failed (${res.status})`);
      }
      setAnswer(j.answer || "");
      setCitations(Array.isArray(j.citations) ? j.citations : []);
    } catch (err) {
      setAskError(err.message);
    } finally {
      setAsking(false);
    }
  }

  const canAsk = Boolean(selectedId && selectedDoc && selectedDoc.status === "ready" && !asking);
  const canUpload = !uploading;

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-6xl px-4 py-6">
          <h1 className="text-3xl font-bold tracking-tight text-gray-900">DocuMind</h1>
          <p className="mt-1 text-sm text-gray-600">
            Upload a PDF, select a ready document, and ask a question. Answers include page-level citations.
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-6 grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border bg-white shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-lg font-semibold text-gray-900">Documents</h2>
          </div>
          <div className="p-4 space-y-4">
            <form onSubmit={handleUpload} className="space-y-2">
              <label htmlFor="pdf" className="block text-sm font-medium text-gray-700">
                Upload PDF
              </label>
              <input
                ref={fileInputRef}
                id="pdf"
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                className="block w-full text-sm text-gray-900 file:mr-4 file:rounded-md file:border-0 file:bg-gray-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2"
              />
              <button
                type="submit"
                disabled={!canUpload}
                className="inline-flex items-center rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2"
              >
                {uploading ? "Uploading…" : "Upload PDF"}
              </button>
              {uploadError && <p className="text-sm text-red-600">{uploadError}</p>}
              {uploadMsg && <p className="text-sm text-green-700">{uploadMsg}</p>}
            </form>

            <div>
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-medium text-gray-900">Library</h3>
                <button
                  type="button"
                  onClick={fetchDocuments}
                  disabled={loadingDocs}
                  className="text-xs font-medium text-gray-700 hover:text-gray-900 disabled:opacity-50"
                >
                  {loadingDocs ? "Refreshing…" : "Refresh"}
                </button>
              </div>
              {docsError && <p className="mb-2 text-sm text-red-600">{docsError}</p>}
              <div className="space-y-2 max-h-[400px] overflow-auto">
                {documents.length === 0 && !loadingDocs && (
                  <p className="text-sm text-gray-500">No documents yet.</p>
                )}
                {documents.map((d) => {
                  const id = d._id || d.id;
                  const isSelected = selectedId === id;
                  const status = d.status;
                  return (
                    <label
                      key={id}
                      className={`flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm ${isSelected ? "border-gray-900 bg-gray-50" : "border-gray-200 bg-white"}`}
                    >
                      <input
                        type="radio"
                        name="doc"
                        value={id}
                        checked={isSelected}
                        onChange={handleSelect}
                        className="mt-0.5 h-4 w-4 border-gray-300 text-gray-900 focus:ring-gray-900"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <p className="truncate font-medium text-gray-900" title={d.filename}>
                            {d.filename}
                          </p>
                          <span
                            className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${status === "ready"
                              ? "bg-green-100 text-green-800"
                              : status === "failed"
                                ? "bg-red-100 text-red-800"
                                : "bg-yellow-100 text-yellow-800"
                              }`}
                          >
                            {status}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-gray-500">
                          Pages: {d.pageCount ?? 0} · {formatDate(d.createdAt || d.updatedAt)}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-lg border bg-white shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-lg font-semibold text-gray-900">Ask a question</h2>
          </div>
          <div className="p-4 space-y-4">
            <form onSubmit={handleAsk} className="space-y-2">
              <label htmlFor="question" className="block text-sm font-medium text-gray-700">
                Question
              </label>
              <textarea
                id="question"
                rows={4}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={selectedDoc?.status === "ready" ? "Ask about this document…" : "Select a ready document to enable asking."}
                disabled={!canAsk && !(selectedId && selectedDoc?.status === "ready" && !asking)}
                className="block w-full rounded-md border-gray-300 text-sm shadow-sm focus:border-gray-900 focus:ring-gray-900 disabled:bg-gray-100 disabled:text-gray-500"
              />
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  {selectedId ? `Selected: ${selectedDoc?.filename || selectedId}` : "No document selected."}
                  {selectedDoc && selectedDoc.status !== "ready" && " — not ready"}
                </p>
                <button
                  type="submit"
                  disabled={!canAsk}
                  className="inline-flex items-center rounded-md bg-gray-900 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-900 focus:ring-offset-2"
                >
                  {asking ? "Asking…" : "Ask"}
                </button>
              </div>
              {askError && <p className="text-sm text-red-600">{askError}</p>}
            </form>

            <div className="space-y-3">
              <h3 className="text-sm font-medium text-gray-900">Answer</h3>
              {answer ? (
                <div className="rounded-md border bg-gray-50 p-3 text-sm text-gray-900 whitespace-pre-wrap">
                  {answer}
                </div>
              ) : asking ? (
                <p className="text-sm text-gray-500">Generating answer…</p>
              ) : (
                <p className="text-sm text-gray-500">No answer yet.</p>
              )}
              {citations.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700">Citations</h4>
                  <ul className="mt-1 space-y-1 text-xs text-gray-600">
                    {citations.map((c, i) => (
                      <li key={`${c.pageNumber}:${c.chunkIndex}:${i}`}>
                        Page {c.pageNumber}
                        {Number.isInteger(c.chunkIndex) ? ` · chunk ${c.chunkIndex}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
