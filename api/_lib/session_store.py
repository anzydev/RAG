"""
Shared session store for RAG Assistant.

Stores session data (chunks + embeddings) using JSON files in /tmp.
This approach works for:
  - Local dev (dev_server.py): all in one process, falls back to in-memory
  - Vercel serverless: uses /tmp which is shared within the same warm container

For production at scale, swap this with Redis/Upstash/Vercel KV.
"""

import json
import os
import time
import hashlib
import threading

# ---- Configuration ----
SESSION_DIR = os.path.join("/tmp", "rag_sessions")
SESSION_TTL_SECONDS = 3600  # 1 hour
MAX_SESSIONS = 50  # Max sessions before cleanup

_lock = threading.Lock()


def _ensure_dir():
    os.makedirs(SESSION_DIR, exist_ok=True)


def _session_path(session_id: str) -> str:
    """Get the file path for a session, sanitizing the ID."""
    safe_id = hashlib.sha256(session_id.encode()).hexdigest()[:32]
    return os.path.join(SESSION_DIR, f"{safe_id}.json")


def save_session(session_id: str, data: dict) -> None:
    """Save session data to disk."""
    _ensure_dir()
    payload = {
        "created_at": time.time(),
        "session_id": session_id,
        "data": {
            "chunks": data["chunks"],
            "embeddings": data["embeddings"],
            "filenames": data["filenames"],
        },
    }
    path = _session_path(session_id)
    with _lock:
        with open(path, "w") as f:
            json.dump(payload, f)


def load_session(session_id: str) -> dict | None:
    """Load session data from disk. Returns None if not found or expired."""
    path = _session_path(session_id)
    if not os.path.exists(path):
        return None

    try:
        with open(path, "r") as f:
            payload = json.load(f)
    except (json.JSONDecodeError, IOError):
        return None

    # Check TTL
    if time.time() - payload.get("created_at", 0) > SESSION_TTL_SECONDS:
        try:
            os.remove(path)
        except OSError:
            pass
        return None

    # Verify session ID matches
    if payload.get("session_id") != session_id:
        return None

    return payload.get("data")


def delete_session(session_id: str) -> None:
    """Delete a session."""
    path = _session_path(session_id)
    try:
        os.remove(path)
    except OSError:
        pass


def cleanup_expired_sessions() -> int:
    """Remove expired sessions. Returns number of sessions removed."""
    _ensure_dir()
    removed = 0
    now = time.time()

    try:
        files = sorted(os.listdir(SESSION_DIR))
    except OSError:
        return 0

    for fname in files:
        if not fname.endswith(".json"):
            continue
        path = os.path.join(SESSION_DIR, fname)
        try:
            with open(path, "r") as f:
                payload = json.load(f)
            if now - payload.get("created_at", 0) > SESSION_TTL_SECONDS:
                os.remove(path)
                removed += 1
        except (json.JSONDecodeError, IOError, OSError):
            # Corrupted file, remove it
            try:
                os.remove(path)
                removed += 1
            except OSError:
                pass

    # If still too many sessions, remove oldest
    try:
        files = sorted(os.listdir(SESSION_DIR))
        json_files = [f for f in files if f.endswith(".json")]
        if len(json_files) > MAX_SESSIONS:
            for fname in json_files[: len(json_files) - MAX_SESSIONS]:
                try:
                    os.remove(os.path.join(SESSION_DIR, fname))
                    removed += 1
                except OSError:
                    pass
    except OSError:
        pass

    return removed
