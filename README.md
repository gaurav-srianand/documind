# DocuMind — Chat with Your PDFs

DocuMind is a PDF question-answering application built using Retrieval-Augmented Generation (RAG). Upload a PDF, ask questions about its contents, and receive answers grounded in the document with page-level citations.

## Features

- Upload and process PDF documents
- Extract text and split it into manageable chunks
- Generate text embeddings locally
- Store and retrieve document vectors using ChromaDB
- Ask questions in natural language
- Generate context-grounded answers using Groq
- Display page and chunk citations
- Store document metadata in MongoDB

## Tech Stack

- **Frontend:** Next.js, React, Tailwind CSS
- **Backend:** Next.js App Router API routes
- **Database:** MongoDB Atlas with Mongoose
- **Vector database:** ChromaDB
- **Embeddings:** Transformers.js, ONNX Runtime, `all-MiniLM-L6-v2`
- **LLM provider:** Groq
- **PDF processing:** PDF.js
- **Language:** JavaScript

## How It Works

1. Upload a PDF.
2. Extract text and divide it into chunks.
3. Generate a 384-dimensional embedding for each chunk locally.
4. Store the chunk text, embeddings, and metadata in ChromaDB.
5. Save document metadata in MongoDB.
6. When a question is submitted, embed the question and retrieve relevant chunks from the selected document.
7. Send the retrieved context and question to Groq.
8. Return an answer with citations referencing the source pages and chunks.

## Prerequisites

- Node.js and npm
- Docker Desktop
- A MongoDB Atlas connection string
- A Groq API key

## Local Setup

### 1. Clone the repository

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd documind
```

Replace the placeholder with your actual repository URL.

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create a `.env` file in the project root, or copy `.env.example` to `.env` and fill in the required values.

Required settings:

- `MONGODB_URI` — MongoDB connection string
- `GROQ_API_KEY` — Groq API key
- `CHROMA_HOST` — `localhost` for local development
- `CHROMA_PORT` — `8000`
- `CHROMA_COLLECTION` — `documind`

Never commit `.env` or expose API keys and database credentials.

### 4. Start ChromaDB with persistent storage

From the project root, run:

```bash
mkdir -p chroma-data

docker run --rm --name documind-chroma \
  -p 8000:8000 \
  -v "$(pwd)/chroma-data:/data" \
  chromadb/chroma
```

Keep this terminal open while using the application.

The local `chroma-data` directory stores ChromaDB's persistent data. Mounting it at `/data` matches the persistence path used by this container configuration, allowing the database to survive container restarts.

To stop ChromaDB, press `Ctrl+C`. Run the same command again to restart it.

### 5. Start the application

In a second terminal, from the project root:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment and Data Notes

- Keep `.env` out of version control.
- The `chroma-data` directory contains local vector database data and should not be committed to Git.
- `chroma-data-backup` is a local backup and should not be committed.
- Local embeddings run on the application server; the first model load may take longer.
- Scanned PDFs that contain images rather than extractable text may require OCR, which is not currently included.
- This setup is intended for local development. Deployment requires additional configuration for a hosted vector database, model execution, and serverless runtime limits.

## Current Limitations

- No OCR for scanned PDFs
- No user authentication or per-user document access
- No persistent chat history
- No streaming answers
- Local ChromaDB and embedding setup is not yet configured for production deployment

## Future Improvements

- Hosted vector database and deployment-friendly embedding infrastructure
- Authentication and document-level access controls
- OCR support
- Chat history and streaming responses
- Automated end-to-end tests
- Retrieval relevance thresholds and improved evaluation

## License

Add a license if and when you choose to distribute the project under one.
