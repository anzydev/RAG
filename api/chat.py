"""
Chat endpoint — runs RAG retrieval + generation.
POST /api/chat
Body: { question, session_id, history }
Returns: { answer, sources }
"""
from http.server import BaseHTTPRequestHandler
import json

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from _lib.rag_engine import get_embeddings, retrieve_chunks, build_context, generate_answer
from _lib.session_store import load_session


class handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Api-Key")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(content_length))
            api_key = (self.headers.get("X-Api-Key") or "").strip() or None

            question = body.get("question", "")
            session_id = body.get("session_id", "")
            history = body.get("history", [])

            if not question:
                self._send_json(400, {"error": "Question is required"})
                return
            if not session_id:
                self._send_json(400, {"error": "Invalid session. Please re-upload your documents."})
                return

            session = load_session(session_id)
            if session is None:
                self._send_json(400, {"error": "Session expired or not found. Please re-upload your documents."})
                return

            chunks = session["chunks"]
            embeddings = session["embeddings"]

            query_embedding = get_embeddings([question], api_key=api_key)[0]
            semantic_chunks, early_chunks = retrieve_chunks(query_embedding, chunks, embeddings)

            context = build_context(semantic_chunks, early_chunks)
            answer = generate_answer(question, context, history, api_key=api_key)

            sources = []
            for ec in early_chunks:
                sources.append({"text": ec["text"], "page": ec.get("page", "?"), "source": ec.get("source", "unknown")})
            for sc in semantic_chunks:
                sources.append({"text": sc["text"], "page": sc.get("page", "?"), "source": sc.get("source", "unknown")})

            self._send_json(200, {"answer": answer, "sources": sources})

        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
