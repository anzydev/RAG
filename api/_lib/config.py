import os

# ---- API Configuration ----
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# ---- Model Configuration ----
CHAT_MODEL = "openai/gpt-4o-mini"
EMBEDDING_MODEL = "openai/text-embedding-3-small"
MAX_RESPONSE_TOKENS = 2048

# ---- RAG Configuration ----
CHUNK_SIZE = 800
CHUNK_OVERLAP = 150
SEMANTIC_TOP_K = 25         # Top 25 most relevant chunks
EARLY_PAGE_LIMIT = 15
EARLY_PAGE_MAX_CHUNKS = 10  # Up to 10 early-page chunks for structure
MAX_CONTEXT_CHARS = 30000   # ~7500 tokens — GPT-4o-mini has 128K capacity

# ---- Upload Limits ----
MAX_FILE_SIZE_MB = 100      # Max file size in MB per file
MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024
MAX_FILES_PER_UPLOAD = 10   # Max number of files in one upload
