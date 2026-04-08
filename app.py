import os
os.environ["TOKENIZERS_PARALLELISM"] = "false"

import re
import uuid
import streamlit as st

# ---- PAGE CONFIG (must be first Streamlit command) ----
st.set_page_config(
    page_title="RAG Assistant",
    page_icon="🧠",
    layout="centered",
    initial_sidebar_state="expanded",
)

from dotenv import load_dotenv
from openai import OpenAI
from pypdf import PdfReader
from sentence_transformers import SentenceTransformer
import chromadb

# ---- LOAD ENV ----
load_dotenv()

# ---- CONFIG ----
client = OpenAI(
    api_key=os.getenv("OPENROUTER_API_KEY"),
    base_url="https://openrouter.ai/api/v1",
)

# ---- EMBEDDING MODEL ----
@st.cache_resource(show_spinner="Loading embedding model...")
def load_embedding_model():
    return SentenceTransformer("all-MiniLM-L6-v2")

embedding_model = load_embedding_model()

# ---- CHROMA DB ----
@st.cache_resource(show_spinner=False)
def load_db():
    return chromadb.Client().get_or_create_collection(name="docs")

collection = load_db()

# ---- SESSION STATE ----
defaults = {
    "history": [],
    "doc_loaded": False,
    "uploaded_filenames": [],
    "chunk_count": 0,
}
for k, v in defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v

# Safety check: if session says docs loaded but ChromaDB is empty, reset
if st.session_state.doc_loaded and collection.count() == 0:
    st.session_state.doc_loaded = False
    st.session_state.uploaded_filenames = []
    st.session_state.chunk_count = 0


# =====================================================================
#  HELPERS
# =====================================================================

def clean_text(text: str) -> str:
    """Clean up messy PDF-extracted text."""
    text = re.sub(r'\n\s*\n', '\n\n', text)   # collapse blank lines
    text = re.sub(r'[ \t]+', ' ', text)        # collapse whitespace
    return text.strip()


def chunk_text_by_page(text: str, page_num: int, chunk_size=800, overlap=150):
    """Split a single page's text into overlapping chunks with page metadata."""
    text = clean_text(text)
    if not text:
        return []

    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        # Try to break at a sentence boundary
        if end < len(text):
            for sep in ['. ', '.\n', '\n\n', '\n']:
                pos = text.rfind(sep, start + chunk_size // 2, end)
                if pos != -1:
                    end = pos + len(sep)
                    break
        chunk = text[start:end].strip()
        if chunk and len(chunk) > 20:  # skip tiny fragments
            chunks.append({"text": chunk, "page": page_num})
        start = end - overlap
    return chunks


def ingest_documents(files):
    """Extract text from files, chunk, embed, and store in ChromaDB."""
    all_chunks = []

    for file in files:
        if file.type == "application/pdf":
            reader = PdfReader(file)
            for i, page in enumerate(reader.pages):
                page_text = page.extract_text() or ""
                page_chunks = chunk_text_by_page(page_text, page_num=i + 1)
                all_chunks.extend(page_chunks)
        else:
            text = file.read().decode("utf-8")
            page_chunks = chunk_text_by_page(text, page_num=1)
            all_chunks.extend(page_chunks)

        if file.name not in st.session_state.uploaded_filenames:
            st.session_state.uploaded_filenames.append(file.name)

    if not all_chunks:
        st.error("No usable text found in the uploaded files.")
        return False

    # Batch encode + add (ChromaDB max batch = 5461)
    BATCH = 500
    total = len(all_chunks)
    progress = st.progress(0, text=f"Indexing {total} chunks...")

    for i in range(0, total, BATCH):
        batch = all_chunks[i : i + BATCH]
        texts = [c["text"] for c in batch]
        metas = [{"page": c["page"]} for c in batch]
        embeds = embedding_model.encode(texts).tolist()
        ids = [str(uuid.uuid4()) for _ in batch]
        collection.add(documents=texts, embeddings=embeds, metadatas=metas, ids=ids)
        progress.progress(min((i + BATCH) / total, 1.0),
                          text=f"Indexed {min(i + BATCH, total)}/{total} chunks...")

    progress.empty()
    st.session_state.doc_loaded = True
    st.session_state.chunk_count = total
    return True


def clear_index():
    """Wipe the ChromaDB collection and reset state."""
    try:
        ids = collection.get()["ids"]
        if ids:
            collection.delete(ids=ids)
    except Exception:
        pass
    st.session_state.doc_loaded = False
    st.session_state.uploaded_filenames = []
    st.session_state.chunk_count = 0


def query_rag(question: str) -> tuple[str, list]:
    """Run the full RAG pipeline: embed → retrieve → generate."""
    q_embed = embedding_model.encode([question]).tolist()
    total_docs = collection.count()

    if total_docs == 0:
        return "No documents have been indexed yet.", []

    # ---- STAGE 1: Semantic retrieval (top 40 most relevant chunks) ----
    n_semantic = min(40, total_docs)
    results = collection.query(query_embeddings=q_embed, n_results=n_semantic)

    sem_chunks = results.get("documents", [[]])[0] if results.get("documents") else []
    sem_metas = results.get("metadatas", [[]])[0] if results.get("metadatas") else []
    sem_ids = results.get("ids", [[]])[0] if results.get("ids") else []

    # ---- STAGE 2: Inject early-page chunks (TOC, intro — pages 1-15) ----
    # Broad queries about "chapters", "overview", "structure" need the TOC
    try:
        all_data = collection.get(include=["documents", "metadatas"])
        all_docs = all_data.get("documents", [])
        all_metas = all_data.get("metadatas", [])
        all_ids_list = all_data.get("ids", [])

        early_chunks = []
        for doc, meta, doc_id in zip(all_docs, all_metas, all_ids_list):
            if meta and meta.get("page", 999) <= 15 and doc_id not in sem_ids:
                early_chunks.append({"text": doc, "meta": meta, "id": doc_id})

        # Add early-page chunks to the front (up to 20)
        early_chunks = early_chunks[:20]
    except Exception:
        early_chunks = []

    # ---- BUILD COMBINED CONTEXT ----
    context_parts = []

    # Early pages first (document structure)
    if early_chunks:
        context_parts.append("=== DOCUMENT STRUCTURE (Early Pages) ===")
        for ec in early_chunks:
            page = ec["meta"].get("page", "?") if ec["meta"] else "?"
            context_parts.append(f"[Page {page}]\n{ec['text']}")

    # Then semantic matches
    context_parts.append("\n=== RELEVANT CONTENT ===")
    for i, chunk in enumerate(sem_chunks):
        meta = sem_metas[i] if i < len(sem_metas) and sem_metas[i] else {}
        page = meta.get("page", "?")
        context_parts.append(f"[Page {page}]\n{chunk}")

    context = "\n\n---\n\n".join(context_parts)

    # Build conversation history (last 6 messages)
    recent = st.session_state.history[-6:]
    conv = "\n".join(f"{m['role'].upper()}: {m['content']}" for m in recent)

    prompt = f"""You are a document assistant. Answer the question using the retrieved context below.

RULES:
- Use the context thoroughly. Synthesize information from ALL relevant sections.
- The DOCUMENT STRUCTURE section contains early pages (table of contents, preface, etc.) — use it for structural questions.
- Quote or reference page numbers when possible (e.g. "On page 5...").
- If the context clearly contains information about the topic, provide a detailed answer.
- Only say "not enough information" if the context is completely unrelated.
- Use markdown: headers, bullet points, bold for key terms.

CONTEXT:
{context}

CONVERSATION HISTORY:
{conv}

QUESTION: {question}

ANSWER:"""

    response = client.chat.completions.create(
        model="openai/gpt-4o-mini",
        messages=[
            {"role": "system", "content": "You are a thorough document assistant. Always synthesize from provided context and cite page numbers."},
            {"role": "user", "content": prompt},
        ],
    )

    answer = response.choices[0].message.content

    # Format sources for display
    sources = []
    for ec in early_chunks:
        page = ec["meta"].get("page", "?") if ec["meta"] else "?"
        sources.append({"text": ec["text"], "page": page})
    for i, chunk in enumerate(sem_chunks):
        meta = sem_metas[i] if i < len(sem_metas) and sem_metas[i] else {}
        sources.append({"text": chunk, "page": meta.get("page", "?")})

    return answer, sources


# =====================================================================
#  MINIMAL DARK CSS
# =====================================================================
st.markdown("""
<style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    :root {
        --bg: #0a0a0a;
        --surface: #141414;
        --border: #262626;
        --text: #fafafa;
        --text2: #a1a1aa;
        --accent: #3b82f6;
    }

    .stApp, [data-testid="stAppViewContainer"], [data-testid="stMain"] {
        background-color: var(--bg) !important;
        color: var(--text) !important;
        font-family: 'Inter', sans-serif !important;
    }

    /* Keep Material Icons working */
    .material-symbols-rounded, span.material-symbols-rounded {
        font-family: 'Material Symbols Rounded' !important;
    }

    [data-testid="stHeader"] {
        background: rgba(10,10,10,0.85) !important;
        backdrop-filter: blur(10px) !important;
    }

    footer, #MainMenu { display: none !important; }

    .block-container {
        max-width: 800px !important;
        padding-top: 1.5rem !important;
        padding-bottom: 5rem !important;
    }

    /* Sidebar */
    [data-testid="stSidebar"] {
        background-color: var(--surface) !important;
        border-right: 1px solid var(--border) !important;
    }

    /* Buttons */
    .stButton > button {
        background: var(--surface) !important;
        color: var(--text2) !important;
        border: 1px solid var(--border) !important;
        border-radius: 8px !important;
        font-family: 'Inter', sans-serif !important;
        font-size: 0.85rem !important;
        transition: all 0.15s !important;
    }
    .stButton > button:hover {
        border-color: var(--text2) !important;
        color: var(--text) !important;
    }

    /* File uploader */
    [data-testid="stFileUploader"] {
        background: var(--surface) !important;
        border: 1px dashed var(--border) !important;
        border-radius: 8px !important;
        padding: 12px !important;
    }

    /* Chat messages */
    [data-testid="stChatMessage"] {
        background: var(--surface) !important;
        border: 1px solid var(--border) !important;
        border-radius: 10px !important;
        padding: 12px 16px !important;
        margin-bottom: 8px !important;
    }

    /* Chat input */
    [data-testid="stChatInput"] {
        background: var(--surface) !important;
    }
    [data-testid="stChatInput"] textarea {
        background: var(--surface) !important;
        color: var(--text) !important;
        border: 1px solid var(--border) !important;
        border-radius: 10px !important;
    }

    /* Expander */
    .streamlit-expanderHeader {
        background: var(--surface) !important;
        border: 1px solid var(--border) !important;
        border-radius: 8px !important;
        color: var(--text2) !important;
    }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 5px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    /* Caption & small text */
    .stCaption, small { color: var(--text2) !important; }
</style>
""", unsafe_allow_html=True)


# =====================================================================
#  SIDEBAR
# =====================================================================
with st.sidebar:
    st.markdown("### 🧠 RAG Assistant")

    if st.session_state.doc_loaded:
        st.success(f"✅ {len(st.session_state.uploaded_filenames)} file(s) · {st.session_state.chunk_count} chunks")
        for name in st.session_state.uploaded_filenames:
            st.caption(f"📄 {name}")
        st.divider()

        # Upload more docs
        extra_files = st.file_uploader(
            "Add more documents",
            type=["pdf", "txt"],
            accept_multiple_files=True,
            key="sidebar_upload",
        )
        if extra_files:
            with st.spinner("Processing..."):
                ingest_documents(extra_files)
            st.rerun()

        st.divider()
        if st.button("🔄 Re-index", use_container_width=True):
            clear_index()
            st.rerun()
        if st.button("🗑️ Clear Chat", use_container_width=True):
            st.session_state.history = []
            st.rerun()
    else:
        st.caption("Upload a document in the main area to get started.")


# =====================================================================
#  MAIN
# =====================================================================

# ---- Upload area (shown when no docs loaded) ----
if not st.session_state.doc_loaded:
    st.markdown("## 🧠 RAG Assistant")
    st.caption("Upload a PDF or TXT file, then ask questions about it.")
    st.divider()

    files = st.file_uploader(
        "Upload documents",
        type=["pdf", "txt"],
        accept_multiple_files=True,
        key="main_upload",
    )

    if files:
        with st.spinner("Processing..."):
            success = ingest_documents(files)
        if success:
            st.rerun()

# ---- Chat interface (shown when docs are loaded) ----
else:
    # Render history
    for msg in st.session_state.history:
        role = msg["role"]
        avatar = "🧑‍💻" if role == "user" else "🤖"
        with st.chat_message(role, avatar=avatar):
            st.markdown(msg["content"])
            # Show sources if stored
            if role == "assistant" and msg.get("sources"):
                with st.expander(f"📚 Sources ({len(msg['sources'])} chunks)", expanded=False):
                    for s in msg["sources"][:5]:
                        st.caption(f"**Page {s['page']}**")
                        st.text(s["text"][:300] + ("..." if len(s["text"]) > 300 else ""))
                        st.divider()

    # Chat input
    if query := st.chat_input("Ask a question about your documents..."):
        # Show user message
        with st.chat_message("user", avatar="🧑‍💻"):
            st.markdown(query)
        st.session_state.history.append({"role": "user", "content": query})

        # Generate answer
        with st.chat_message("assistant", avatar="🤖"):
            with st.spinner("Thinking..."):
                try:
                    answer, sources = query_rag(query)
                    st.markdown(answer)

                    if sources:
                        with st.expander(f"📚 Sources ({len(sources)} chunks)", expanded=False):
                            for s in sources[:5]:
                                st.caption(f"**Page {s['page']}**")
                                st.text(s["text"][:300] + ("..." if len(s["text"]) > 300 else ""))
                                st.divider()

                    st.session_state.history.append({
                        "role": "assistant",
                        "content": answer,
                        "sources": sources,
                    })
                except Exception as e:
                    st.error(f"Error: {e}")
                    st.session_state.history.append({"role": "assistant", "content": f"Error: {e}"})