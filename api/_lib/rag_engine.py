"""
RAG Engine — chunking, embedding, retrieval, and generation.
Pure Python + OpenRouter API + NumPy cosine similarity.

Pipeline: Ingest → Chunk → Embed → Store → Retrieve → Generate
"""

import re
import numpy as np
from openai import OpenAI
from pypdf import PdfReader
from io import BytesIO
import concurrent.futures

from .config import (
    OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL,
    CHAT_MODEL,
    EMBEDDING_MODEL,
    CHUNK_SIZE,
    CHUNK_OVERLAP,
    SEMANTIC_TOP_K,
    EARLY_PAGE_LIMIT,
    EARLY_PAGE_MAX_CHUNKS,
    MAX_CONTEXT_CHARS,
    MAX_RESPONSE_TOKENS,
)


def _get_client(api_key: str | None = None) -> OpenAI:
    key = api_key or OPENROUTER_API_KEY
    if not key:
        raise Exception("No API key configured. Please provide your OpenRouter API key.")
    return OpenAI(api_key=key, base_url=OPENROUTER_BASE_URL)


# =====================================================================
#  STAGE 1: TEXT EXTRACTION & PROCESSING
# =====================================================================

def clean_text(text: str) -> str:
    """Clean up messy PDF-extracted text."""
    text = re.sub(r'\n\s*\n', '\n\n', text)
    text = re.sub(r'[ \t]+', ' ', text)
    return text.strip()


def _decode_text(file_bytes: bytes) -> str:
    """Decode bytes to text with encoding fallback."""
    try:
        return file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        # Fallback to latin-1 which handles most Western encodings
        return file_bytes.decode("latin-1")


def chunk_text_by_page(text: str, page_num: int) -> list[dict]:
    """Split a single page's text into overlapping chunks with page metadata.
    
    Uses sentence-boundary-aware splitting with configurable chunk_size
    and overlap to maintain context across chunks.
    """
    text = clean_text(text)
    if not text:
        return []

    chunks = []
    start = 0
    while start < len(text):
        end = start + CHUNK_SIZE
        if end < len(text):
            for sep in ['. ', '.\n', '\n\n', '\n']:
                pos = text.rfind(sep, start + CHUNK_SIZE // 2, end)
                if pos != -1:
                    end = pos + len(sep)
                    break
        chunk = text[start:end].strip()
        if chunk and len(chunk) > 20:
            chunks.append({"text": chunk, "page": page_num})
        start = end - CHUNK_OVERLAP
    return chunks


def extract_and_chunk(file_bytes: bytes, filename: str) -> list[dict]:
    """Extract text from a file and return chunks with metadata.
    
    Supports: PDF, TXT, Markdown (.md)
    Each chunk includes: { text, page, source }
    """
    all_chunks = []
    fname_lower = filename.lower()

    if fname_lower.endswith(".pdf"):
        reader = PdfReader(BytesIO(file_bytes))
        for i, page in enumerate(reader.pages):
            page_text = page.extract_text() or ""
            page_chunks = chunk_text_by_page(page_text, page_num=i + 1)
            for c in page_chunks:
                c["source"] = filename
            all_chunks.extend(page_chunks)

    elif fname_lower.endswith(".md") or fname_lower.endswith(".markdown"):
        # Markdown: split by headings for better semantic sections
        text = _decode_text(file_bytes)
        sections = re.split(r'(?=^#{1,3}\s)', text, flags=re.MULTILINE)
        for i, section in enumerate(sections):
            section = section.strip()
            if not section:
                continue
            page_chunks = chunk_text_by_page(section, page_num=i + 1)
            for c in page_chunks:
                c["source"] = filename
            all_chunks.extend(page_chunks)

    else:  # TXT and other text-based formats
        text = _decode_text(file_bytes)
        page_chunks = chunk_text_by_page(text, page_num=1)
        for c in page_chunks:
            c["source"] = filename
        all_chunks.extend(page_chunks)

    return all_chunks


# =====================================================================
#  STAGE 2: EMBEDDING GENERATION
# =====================================================================

def get_embeddings(texts: list[str], api_key: str | None = None) -> list[list[float]]:
    """Get embeddings via OpenRouter / OpenAI compatible API."""
    client = _get_client(api_key)

    all_embeddings = []
    batch_size = 100
    batches = [texts[i:i + batch_size] for i in range(0, len(texts), batch_size)]

    def fetch_batch(batch):
        return client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=batch,
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        future_to_idx = {executor.submit(fetch_batch, batch): idx for idx, batch in enumerate(batches)}
        
        # Collect results in order ensuring alignment with original texts indexing
        results = [None] * len(batches)
        for future in concurrent.futures.as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                response = future.result()
                results[idx] = [item.embedding for item in response.data]
            except Exception as e:
                print(f"  ✗ Embedding API error on batch {idx}: {e}")
                raise Exception(f"Embedding API failed: {e}")

    for res in results:
        if res is not None:
            all_embeddings.extend(res)

    if not all_embeddings:
        raise Exception("No embeddings were generated. Check your API key and credits.")

    return all_embeddings


# =====================================================================
#  STAGE 3: VECTOR RETRIEVAL (Cosine Similarity)
# =====================================================================

def cosine_similarity(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Compute cosine similarity between a query vector and a matrix of doc vectors."""
    a_norm = a / (np.linalg.norm(a) + 1e-10)
    b_norm = b / (np.linalg.norm(b, axis=1, keepdims=True) + 1e-10)
    return np.dot(b_norm, a_norm)


def retrieve_chunks(
    query_embedding: list[float],
    chunks: list[dict],
    embeddings: list[list[float]],
) -> tuple[list[dict], list[dict]]:
    """
    Two-stage retrieval pipeline:
    1. Semantic similarity — top-K most relevant chunks via cosine distance
    2. Early-page injection — injects TOC/intro pages for structural queries
    
    Returns: (semantic_chunks, early_chunks)
    """
    if not chunks or not embeddings:
        return [], []

    query_vec = np.array(query_embedding)
    doc_matrix = np.array(embeddings)

    similarities = cosine_similarity(query_vec, doc_matrix)

    # Stage 1: Semantic top-K
    n_results = min(SEMANTIC_TOP_K, len(chunks))
    top_indices = np.argsort(similarities)[::-1][:n_results]
    semantic_chunks = [chunks[i] for i in top_indices]
    semantic_indices_set = set(top_indices.tolist())

    # Stage 2: Early-page chunks not already in semantic results
    early_chunks = []
    for i, chunk in enumerate(chunks):
        if chunk.get("page", 999) <= EARLY_PAGE_LIMIT and i not in semantic_indices_set:
            early_chunks.append(chunk)
            if len(early_chunks) >= EARLY_PAGE_MAX_CHUNKS:
                break

    return semantic_chunks, early_chunks


# =====================================================================
#  STAGE 4: CONTEXT BUILDING
# =====================================================================

def build_context(semantic_chunks: list[dict], early_chunks: list[dict]) -> str:
    """Build the context string from retrieved chunks with source attribution.
    
    Enforces MAX_CONTEXT_CHARS to avoid exceeding LLM token limits.
    Only includes as many chunks as fit within the budget.
    """
    context_parts = []
    char_count = 0

    if early_chunks:
        context_parts.append("=== DOCUMENT STRUCTURE (Early Pages) ===")
        for ec in early_chunks:
            page = ec.get("page", "?")
            source = ec.get("source", "unknown")
            entry = f"[{source} — Page {page}]\n{ec['text']}"
            if char_count + len(entry) > MAX_CONTEXT_CHARS:
                break
            context_parts.append(entry)
            char_count += len(entry)

    context_parts.append("\n=== RELEVANT CONTENT ===")
    for chunk in semantic_chunks:
        page = chunk.get("page", "?")
        source = chunk.get("source", "unknown")
        entry = f"[{source} — Page {page}]\n{chunk['text']}"
        if char_count + len(entry) > MAX_CONTEXT_CHARS:
            break  # Stop adding chunks once we hit the limit
        context_parts.append(entry)
        char_count += len(entry)

    return "\n\n---\n\n".join(context_parts)


# =====================================================================
#  STAGE 5: ANSWER GENERATION
# =====================================================================

def generate_answer(
    question: str,
    context: str,
    history: list[dict],
    api_key: str | None = None,
) -> str:
    """Generate an answer using the LLM with RAG context and conversation memory."""
    client = _get_client(api_key)

    # Conversation memory: last 6 messages for follow-up context
    recent = history[-6:] if history else []
    conv = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in recent)

    prompt = f"""You are a document-focused AI assistant. Answer the user's questions based on the provided documents.

BEHAVIOR RULES:
- You MUST base your factual answers on the provided CONTEXT.
- Do NOT hallucinate facts or invent outside knowledge.
- If the CONTEXT contains relevant but partial information (e.g. asking to summarize a whole chapter but you only see a few pages), provide the best answer you can from what is available, and note that you only have partial extracts.
- If the question is completely unrelated and NOT answered by the CONTEXT at all, precisely reply with "This information is not provided in the document."
- When possible, cite page numbers and source filenames (e.g. "In document.pdf, on page 5...").
- Use markdown formatting.

CONTEXT:
{context}

CONVERSATION HISTORY:
{conv}

USER MESSAGE: {question}

ANSWER:"""

    response = client.chat.completions.create(
        model=CHAT_MODEL,
        max_tokens=MAX_RESPONSE_TOKENS,
        messages=[
            {"role": "system", "content": "You are a strict AI assistant. You must ONLY answer questions based on the provided uploaded documents. Refuse to answer anything else."},
            {"role": "user", "content": prompt},
        ],
    )

    return response.choices[0].message.content


# =====================================================================
#  AI SUMMARY GENERATION
# =====================================================================

def generate_summary(chunks: list[dict], filenames: list[str], api_key: str | None = None) -> str:
    """Generate an AI summary of the uploaded document(s).
    
    Takes a sample of chunks across the document and produces
    a comprehensive overview.
    """
    client = _get_client(api_key)

    # Sample chunks strategically: early, middle, late
    total = len(chunks)
    if total == 0:
        return "No content to summarize."

    sample_indices = set()
    # First 3 chunks (intro/TOC)
    for i in range(min(3, total)):
        sample_indices.add(i)
    # Middle chunk
    mid = total // 2
    sample_indices.add(mid)
    # Last 2 chunks (conclusion)
    for i in range(max(0, total - 2), total):
        sample_indices.add(i)
    # A few evenly spaced samples
    step = max(1, total // 5)
    for i in range(0, total, step):
        sample_indices.add(i)

    sampled = sorted(sample_indices)[:10]  # Cap at 10 chunks
    sample_text = "\n\n---\n\n".join(
        f"[{chunks[i].get('source', 'unknown')} — Page {chunks[i].get('page', '?')}]\n{chunks[i]['text']}"
        for i in sampled
    )

    file_list = ", ".join(filenames)

    prompt = f"""Provide a comprehensive summary of the following document(s): {file_list}

Based on these representative excerpts from the document(s), write a clear, well-structured summary that covers:
1. **Main Topic/Purpose** — What is this document about?
2. **Key Points** — The most important ideas, findings, or arguments
3. **Structure** — How the document is organized (chapters, sections, etc.)
4. **Notable Details** — Any significant data, conclusions, or recommendations

EXCERPTS:
{sample_text}

Write the summary in markdown format with headers and bullet points. Be thorough but concise (300-500 words)."""

    response = client.chat.completions.create(
        model=CHAT_MODEL,
        max_tokens=MAX_RESPONSE_TOKENS,
        messages=[
            {"role": "system", "content": "You are a document summarization expert. Create clear, comprehensive summaries."},
            {"role": "user", "content": prompt},
        ],
    )

    return response.choices[0].message.content
