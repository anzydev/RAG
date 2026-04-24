"""
Main API Router for Vercel Serverless.
By routing all /api/* requests to this single file, Vercel spins up a single
Lambda container for the backend. This ensures that the /tmp directory is
shared across upload, chat, and summarize requests (as long as the container
remains warm).
"""

from http.server import BaseHTTPRequestHandler
import json
import uuid
import time
import email.parser
import email.policy

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from _lib.rag_engine import extract_and_chunk, get_embeddings, retrieve_chunks, build_context, generate_answer, generate_summary, generate_chat_title
from _lib.session_store import save_session, load_session, cleanup_expired_sessions
from _lib.config import MAX_FILE_SIZE_BYTES, MAX_FILES_PER_UPLOAD

def parse_multipart(content_type: str, body: bytes):
    header = f"Content-Type: {content_type}\r\n\r\n".encode()
    msg = email.message_from_bytes(header + body, policy=email.policy.HTTP)

    files = []
    if msg.is_multipart():
        for part in msg.iter_parts():
            cd = part.get("Content-Disposition", "")
            if "filename=" in cd:
                filename = part.get_filename() or "unknown"
                file_bytes = part.get_payload(decode=True)
                if file_bytes:
                    files.append((filename, file_bytes))
    return files


class handler(BaseHTTPRequestHandler):
    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Api-Key")

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _get_api_key(self) -> str | None:
        key = self.headers.get("X-Api-Key", "").strip()
        return key if key else None

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        self._send_json(200, {
            "status": "ok",
            "service": "RAG Assistant API (Serverless)",
            "version": "2.0.1",
        })

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        if "/api/upload" in self.path:
            self._handle_upload(body)
        elif "/api/chat" in self.path:
            self._handle_chat(body)
        elif "/api/summarize" in self.path:
            self._handle_summarize(body)
        else:
            self._send_json(404, {"error": "Endpoint not found"})

    def _handle_upload(self, body: bytes):
        try:
            content_type = self.headers.get("Content-Type", "")
            api_key = self._get_api_key()

            if "multipart/form-data" not in content_type:
                self._send_json(400, {"error": "Expected multipart/form-data"})
                return

            files = parse_multipart(content_type, body)

            if not files:
                self._send_json(400, {"error": "No files received"})
                return

            if len(files) > MAX_FILES_PER_UPLOAD:
                self._send_json(400, {"error": f"Too many files. Maximum is {MAX_FILES_PER_UPLOAD}."})
                return

            all_chunks = []
            filenames = []

            for filename, file_bytes in files:
                if len(file_bytes) > MAX_FILE_SIZE_BYTES:
                    self._send_json(400, {
                        "error": f"File '{filename}' exceeds the {MAX_FILE_SIZE_BYTES // (1024*1024)}MB limit."
                    })
                    return

                filenames.append(filename)
                chunks = extract_and_chunk(file_bytes, filename)
                all_chunks.extend(chunks)

            if not all_chunks:
                self._send_json(400, {"error": "No usable text found in the uploaded files."})
                return

            texts = [c["text"] for c in all_chunks]
            embeddings = get_embeddings(texts, api_key=api_key)

            session_id = str(uuid.uuid4())
            save_session(session_id, {
                "chunks": all_chunks,
                "embeddings": embeddings,
                "filenames": filenames,
            })

            cleanup_expired_sessions()

            self._send_json(200, {
                "session_id": session_id,
                "filenames": filenames,
                "chunk_count": len(all_chunks),
            })

        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _handle_chat(self, body: bytes):
        try:
            data = json.loads(body)
            question = data.get("question", "")
            session_id = data.get("session_id", "")
            history = data.get("history", [])
            is_first_message = data.get("is_first_message", False)
            api_key = self._get_api_key()

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
            session_filenames = session.get("filenames", [])

            query_embedding = get_embeddings([question], api_key=api_key)[0]
            semantic_chunks, early_chunks = retrieve_chunks(query_embedding, chunks, embeddings)
            context = build_context(semantic_chunks, early_chunks)
            answer = generate_answer(question, context, history, api_key=api_key, filenames=session_filenames)

            sources = []
            for ec in early_chunks:
                sources.append({"text": ec["text"], "page": ec.get("page", "?"), "source": ec.get("source", "unknown")})
            for sc in semantic_chunks:
                sources.append({"text": sc["text"], "page": sc.get("page", "?"), "source": sc.get("source", "unknown")})

            # Generate a short title for the chat if this is the first message
            suggested_title = None
            if is_first_message:
                try:
                    suggested_title = generate_chat_title(question, answer, api_key=api_key)
                except Exception:
                    pass

            response_data = {
                "answer": answer,
                "sources": sources,
            }
            if suggested_title:
                response_data["suggested_title"] = suggested_title

            self._send_json(200, response_data)

        except Exception as e:
            self._send_json(500, {"error": str(e)})

    def _handle_summarize(self, body: bytes):
        try:
            data = json.loads(body)
            session_id = data.get("session_id", "")
            api_key = self._get_api_key()

            if not session_id:
                self._send_json(400, {"error": "Invalid session."})
                return

            session = load_session(session_id)
            if session is None:
                self._send_json(400, {"error": "Session expired or not found. Please re-upload your documents."})
                return

            summary = generate_summary(session["chunks"], session["filenames"], api_key=api_key)
            self._send_json(200, {"summary": summary})

        except Exception as e:
            self._send_json(500, {"error": str(e)})
