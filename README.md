# 🧠 RAG Assistant

A full-stack **Retrieval-Augmented Generation** application. Upload documents, get AI summaries, and ask questions — answers are grounded in your uploaded content with source citations.

![React](https://img.shields.io/badge/React-19-blue?logo=react)
![Python](https://img.shields.io/badge/Python-3.11+-green?logo=python)
![Vite](https://img.shields.io/badge/Vite-6-purple?logo=vite)
![License](https://img.shields.io/badge/License-MIT-yellow)

## ✨ Features

- 📄 **Multi-format upload** — PDF, TXT, and Markdown support
- 🧩 **Smart chunking** — Sentence-boundary-aware text splitting with overlap
- 🔍 **Semantic search** — Embeddings + cosine similarity retrieval
- 🤖 **RAG Q&A** — Ask questions and get cited, context-grounded answers
- 📝 **AI summaries** — Auto-generated document overviews
- 💬 **Conversation memory** — Follow-up questions with history context
- 📚 **Source citations** — Shows which document and page each answer came from
- 🔑 **Bring your own key** — Use your own OpenRouter API key from the UI
- 🌙 **Dark UI** — Clean, minimal chat interface

## 🏗 Architecture

```
Frontend (React + Vite + TypeScript + Tailwind)
   ↕  HTTP API  ↕
Backend (Python serverless functions)
   ↕  OpenRouter API  ↕
LLM (GPT-4o-mini) + Embeddings (text-embedding-3-small)
```

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+
- **Python** 3.11+
- **OpenRouter API key** — [get one free](https://openrouter.ai/keys)

### 1. Clone & Install

```bash
git clone https://github.com/anzydev/RAG.git
cd RAG

# Frontend
npm install

# Backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 2. Configure

```bash
# Create .env with your API key
echo "OPENROUTER_API_KEY=sk-or-v1-your-key-here" > .env
```

> **Tip:** You can also set your API key from the UI using the **API Key** button (bottom-left corner).

### 3. Run

```bash
# Option A: Start both servers at once
./start.sh

# Option B: Start separately
# Terminal 1 — Backend
source venv/bin/activate
python dev_server.py

# Terminal 2 — Frontend
npm run dev
```

Open **http://localhost:5173** in your browser.

## 🌐 Deploy to Vercel

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set your API key (or let users bring their own via UI)
vercel env add OPENROUTER_API_KEY
```

## 📁 Project Structure

```
RAG/
├── api/                     # Python serverless functions (Vercel)
│   ├── _lib/
│   │   ├── config.py        # API keys, model config, limits
│   │   ├── rag_engine.py    # Core RAG pipeline
│   │   └── session_store.py # Session persistence
│   ├── index.py             # GET  /api         → Health check
│   ├── upload.py            # POST /api/upload   → Upload & index
│   ├── chat.py              # POST /api/chat     → Ask questions
│   └── summarize.py         # POST /api/summarize → AI summary
├── src/                     # React frontend
│   ├── App.tsx              # Main application
│   ├── components/ui/       # UI components
│   ├── hooks/               # React hooks
│   └── lib/                 # Utilities
├── dev_server.py            # Local dev API server
├── start.sh                 # Start both servers
├── vercel.json              # Vercel deployment config
├── PIPELINE.md              # Full pipeline documentation
└── package.json             # Frontend dependencies
```

## 🔧 Pipeline

See **[PIPELINE.md](./PIPELINE.md)** for the full ingestion-to-retrieval pipeline documentation covering:

1. **Ingest** — Parse PDF/TXT/Markdown files
2. **Chunk** — Sentence-boundary splitting (800 chars, 150 overlap)
3. **Embed** — OpenRouter `text-embedding-3-small` (1536 dims)
4. **Store** — Session-based persistence
5. **Retrieve** — Cosine similarity top-25 + early-page injection
6. **Generate** — GPT-4o-mini with RAG context + conversation memory

## 📜 API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api` | Health check |
| `POST` | `/api/upload` | Upload & index documents (multipart/form-data) |
| `POST` | `/api/chat` | Ask a question (`{ question, session_id, history }`) |
| `POST` | `/api/summarize` | Generate AI summary (`{ session_id }`) |

All endpoints accept an optional `X-Api-Key` header to use a custom OpenRouter key.

## 📄 License

MIT