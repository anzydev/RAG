# 🧠 RAG Assistant

A premium, AI-powered Retrieval-Augmented Generation (RAG) assistant that lets you upload documents and ask intelligent questions grounded in your content.

![Python](https://img.shields.io/badge/Python-3.9+-3776AB?style=flat-square&logo=python&logoColor=white)
![Streamlit](https://img.shields.io/badge/Streamlit-1.30+-FF4B4B?style=flat-square&logo=streamlit&logoColor=white)
![ChromaDB](https://img.shields.io/badge/ChromaDB-Vector%20Store-green?style=flat-square)
![OpenRouter](https://img.shields.io/badge/OpenRouter-GPT--4o--mini-blue?style=flat-square)

---

## ✨ Features

- **📄 Multi-format Upload** — Supports PDF and TXT files
- **🔍 Semantic Search** — Finds the most relevant chunks using sentence embeddings
- **💬 Chat Interface** — Conversational Q&A with full history
- **📚 Source Attribution** — See exactly which document chunks were used
- **📝 Document Summary** — One-click summarization of all uploaded content
- **🎨 Premium UI** — Dark-themed glassmorphism design with animations

## 🏗️ Architecture

```
User Upload → PDF/TXT Parsing → Text Chunking (500 chars, 50 overlap)
    → Embedding (all-MiniLM-L6-v2) → ChromaDB Vector Store

User Query → Query Embedding → Semantic Retrieval (top 3)
    → Context + History → GPT-4o-mini via OpenRouter → Answer
```

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd RAG
python -m venv venv
source venv/bin/activate   # macOS/Linux
pip install -r requirements.txt
```

### 2. Configure Environment

Create a `.env` file:

```env
OPENROUTER_API_KEY=your_openrouter_api_key_here
```

Get your API key from [openrouter.ai](https://openrouter.ai/).

### 3. Run

```bash
streamlit run app.py
```

The app opens at `http://localhost:8501`.

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `streamlit` | Web UI framework |
| `openai` | OpenRouter API client |
| `python-dotenv` | Environment variable loading |
| `pypdf` | PDF text extraction |
| `chromadb` | Vector database |
| `sentence-transformers` | Local embedding model |
| `torch` | ML backend for embeddings |

## 🔧 Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Chunk size | 500 chars | Size of each text chunk |
| Chunk overlap | 50 chars | Overlap between chunks |
| Embedding model | `all-MiniLM-L6-v2` | HuggingFace sentence transformer |
| LLM | `openai/gpt-4o-mini` | via OpenRouter |
| Top-K results | 3 | Number of chunks retrieved |

## 📄 License

MIT