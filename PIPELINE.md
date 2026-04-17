# RAG Pipeline Documentation

Full pipeline documentation from document ingestion to answer retrieval.

## Pipeline Overview

```
┌─────────────┐     ┌──────────┐     ┌───────────┐     ┌───────────┐     ┌────────────┐
│  1. INGEST  │ ──▶ │ 2. CHUNK │ ──▶ │ 3. EMBED  │ ──▶ │ 4. STORE  │ ──▶ │ 5. QUERY   │
│  Upload     │     │  Split   │     │  Vectorize│     │  Session  │     │  Retrieve  │
│  Parse      │     │  Clean   │     │  API call │     │  In-memory│     │  Generate  │
└─────────────┘     └──────────┘     └───────────┘     └───────────┘     └────────────┘
```

---

## Stage 1: Document Ingestion

**Endpoint:** `POST /api/upload`  
**File:** `api/_lib/rag_engine.py` → `extract_and_chunk()`

### Supported Formats

| Format   | Parser         | Page Detection |
|----------|----------------|----------------|
| PDF      | `pypdf`        | Per-page extraction |
| TXT      | UTF-8 decode   | Entire file = page 1 |
| Markdown | UTF-8 decode   | Split by `#` headings → pseudo-pages |

### Process

1. **Upload**: Frontend sends file(s) as `multipart/form-data`
2. **Parse**: Backend reads file bytes, detects format by extension
3. **Extract**: 
   - **PDF**: Iterate each page, extract text with `PdfReader.extract_text()`
   - **TXT**: Direct UTF-8 decode
   - **Markdown**: Split by heading markers (`#`, `##`, `###`) for semantic sections

Each chunk carries metadata:
```json
{
  "text": "The actual chunk content...",
  "page": 5,
  "source": "document.pdf"
}
```

---

## Stage 2: Text Chunking

**File:** `api/_lib/rag_engine.py` → `chunk_text_by_page()`

### Algorithm

1. **Clean text**: Collapse blank lines, normalize whitespace
2. **Sliding window**: Move through text with configurable window size
3. **Sentence-boundary snapping**: Try to break at natural boundaries:
   - Period + space (`. `)
   - Period + newline (`.\n`)
   - Double newline (`\n\n`)
   - Single newline (`\n`)
4. **Overlap**: Each chunk overlaps with the previous by `CHUNK_OVERLAP` characters to maintain context across boundaries
5. **Filter**: Discard fragments shorter than 20 characters

### Configuration

| Parameter      | Default | Description |
|---------------|---------|-------------|
| `CHUNK_SIZE`  | 800     | Target characters per chunk |
| `CHUNK_OVERLAP` | 150   | Overlap between consecutive chunks |

### Example

For a 2000-character page with defaults:
```
Chunk 1: chars    0 – 800  (snapped to sentence boundary)
Chunk 2: chars  650 – 1450 (150 char overlap)
Chunk 3: chars 1300 – 2000 (remaining text)
```

---

## Stage 3: Embedding Generation

**File:** `api/_lib/rag_engine.py` → `get_embeddings()`

### Model

- **Provider**: OpenRouter API (OpenAI-compatible)
- **Model**: `text-embedding-3-small` (1536 dimensions)
- **Batching**: 100 texts per API call to avoid rate limits

### Process

1. Collect all chunk texts into a list
2. Batch into groups of 100
3. Call OpenRouter embeddings API for each batch
4. Collect all embedding vectors (each is 1536-dimensional float array)

### Cost

- ~$0.02 per 1M tokens
- A 100-page PDF generates roughly 500-1000 chunks
- Typical cost: < $0.01 per document

---

## Stage 4: Vector Storage

**File:** `dev_server.py` → `sessions` dict

### Architecture

Vectors are stored **in-memory** in a server-side session:

```python
sessions = {
    "session-uuid": {
        "chunks": [...],       # List of {text, page, source} dicts
        "embeddings": [...],   # List of float[] vectors (1536-dim each)
        "filenames": [...]     # Original filenames
    }
}
```

### Why In-Memory?

| Approach | Pros | Cons |
|----------|------|------|
| **In-memory (current)** | Zero setup, fast, no external deps | Lost on restart, memory-limited |
| ChromaDB | Persistent, feature-rich | Requires disk, can't run on serverless |
| Pinecone | Fully managed, scalable | Requires account, adds latency |

For production at scale, a hosted vector DB (Pinecone, Weaviate, Qdrant) is recommended.

---

## Stage 5: Query & Retrieval

**Endpoint:** `POST /api/chat`  
**File:** `api/_lib/rag_engine.py` → `retrieve_chunks()`, `generate_answer()`

### Two-Stage Retrieval

#### Stage 5a: Semantic Search

1. **Embed query**: Generate embedding for the user's question
2. **Cosine similarity**: Compare query vector against all document vectors
3. **Top-K selection**: Return the 8 most similar chunks

```python
similarity = dot(query_normalized, doc_normalized)
top_indices = argsort(similarities, descending=True)[:8]
```

#### Stage 5b: Early-Page Injection

For structural queries ("What chapters does this have?", "Give me an overview"):

1. Scan all chunks from pages 1–15
2. Add up to 3 early-page chunks NOT already in semantic results
3. Prepend to context as "DOCUMENT STRUCTURE"

This ensures table of contents, preface, and intro material is always available.

### Configuration

| Parameter           | Default | Description |
|--------------------|---------|-------------|
| `SEMANTIC_TOP_K`   | 8       | Number of semantic results |
| `EARLY_PAGE_LIMIT` | 15      | Pages considered "early" |
| `EARLY_PAGE_MAX_CHUNKS` | 3  | Max early-page chunks injected |
| `MAX_CONTEXT_CHARS` | 6000   | Hard cap on context characters (~1500 tokens) |

---

## Stage 6: Answer Generation

**File:** `api/_lib/rag_engine.py` → `generate_answer()`

### Context Assembly

```
=== DOCUMENT STRUCTURE (Early Pages) ===
[document.pdf — Page 1]
<chunk text>

---

=== RELEVANT CONTENT ===
[document.pdf — Page 42]
<chunk text>
```

### Conversation Memory

- Last **6 messages** from chat history are included
- Enables follow-up questions like "What about the second point?"
- Format: `USER: <message>\nASSISTANT: <message>`

### LLM Prompt

The system prompt instructs the model to:
- Synthesize from ALL relevant sections
- Reference page numbers and source documents
- Use markdown formatting (headers, bullets, bold)
- Only say "not enough information" if context is truly unrelated

### Model

- **Provider**: OpenRouter
- **Model**: `openai/gpt-4o-mini`
- **Temperature**: Default (balanced creativity/accuracy)

---

## Stage 7: AI Summary Generation

**Endpoint:** `POST /api/summarize`  
**File:** `api/_lib/rag_engine.py` → `generate_summary()`

### Sampling Strategy

Instead of sending all chunks (which would exceed context limits), we strategically sample:

1. **First 3 chunks** — Introduction, abstract, table of contents
2. **Middle chunk** — Core content
3. **Last 2 chunks** — Conclusion, references
4. **Evenly spaced samples** — Every N-th chunk for coverage (step = total/5)
5. **Cap at 10 chunks** — Stay within token limits

### Output

The summary covers:
- **Main Topic/Purpose** — What the document is about
- **Key Points** — Important ideas, findings, arguments
- **Structure** — How the document is organized
- **Notable Details** — Data, conclusions, recommendations

---

## API Reference

### `GET /api`
Health check. Returns `{ status, service, version }`.

### `POST /api/upload`
Upload and index documents.

**Request**: `multipart/form-data` with field `files`  
**Response**: `{ session_id, filenames, chunk_count }`

### `POST /api/chat`
Ask a question about uploaded documents.

**Request**:
```json
{
  "question": "What is the main argument?",
  "session_id": "uuid-from-upload",
  "history": [
    { "role": "user", "content": "previous question" },
    { "role": "assistant", "content": "previous answer" }
  ]
}
```

**Response**:
```json
{
  "answer": "Based on page 12 of document.pdf...",
  "sources": [
    { "text": "chunk text", "page": 12, "source": "document.pdf" }
  ]
}
```

### `POST /api/summarize`
Generate AI summary of uploaded documents.

**Request**: `{ "session_id": "uuid-from-upload" }`  
**Response**: `{ "summary": "# Summary\n\n..." }`
