"""
Local development server — mirrors the Vercel serverless API endpoints.
Run alongside `npm run dev` for full-stack local development.

Usage: python dev_server.py
"""

import os
import sys

# Load .env file for local development
from dotenv import load_dotenv
load_dotenv()

import json
import uuid
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import email.parser
import email.policy

# Add project root to path so we can import api._lib
sys.path.insert(0, os.path.dirname(__file__))

from api._lib.rag_engine import extract_and_chunk, get_embeddings, retrieve_chunks, build_context, generate_answer, generate_summary, generate_chat_title
from api._lib.session_store import save_session, load_session, cleanup_expired_sessions
from api._lib.config import MAX_FILE_SIZE_BYTES, MAX_FILES_PER_UPLOAD


def parse_multipart(content_type: str, body: bytes):
    """Parse multipart/form-data using email module."""
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


class DevHandler(BaseHTTPRequestHandler):
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
        """Get custom API key from request header, if provided."""
        key = self.headers.get("X-Api-Key", "").strip()
        return key if key else None

    def do_OPTIONS(self):
        self.send_response(200)
        self._send_cors_headers()
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_GET(self):
        if self.path == "/api" or self.path == "/api/":
            self._send_json(200, {
                "status": "ok",
                "service": "RAG Assistant API (dev)",
                "version": "2.0.0",
            })
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        if self.path == "/api/upload":
            self._handle_upload(body)
        elif self.path == "/api/chat":
            self._handle_chat(body)
        elif self.path == "/api/summarize":
            self._handle_summarize(body)
        else:
            self._send_json(404, {"error": "Not found"})

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
                        "error": f"File '{filename}' exceeds the {MAX_FILE_SIZE_BYTES // (1024*1024)}MB size limit."
                    })
                    return

                filenames.append(filename)
                chunks = extract_and_chunk(file_bytes, filename)
                all_chunks.extend(chunks)

            if not all_chunks:
                self._send_json(400, {"error": "No usable text found in the uploaded files."})
                return

            print(f"  → Extracted {len(all_chunks)} chunks from {len(filenames)} file(s)")
            print(f"  → Generating embeddings...")

            t0 = time.time()
            texts = [c["text"] for c in all_chunks]
            embeddings = get_embeddings(texts, api_key=api_key)
            t1 = time.time()

            print(f"  → Done! {len(embeddings)} embeddings in {t1-t0:.1f}s")

            session_id = str(uuid.uuid4())
            save_session(session_id, {
                "chunks": all_chunks,
                "embeddings": embeddings,
                "filenames": filenames,
            })

            removed = cleanup_expired_sessions()
            if removed > 0:
                print(f"  → Cleaned up {removed} expired session(s)")

            self._send_json(200, {
                "session_id": session_id,
                "filenames": filenames,
                "chunk_count": len(all_chunks),
            })

        except Exception as e:
            print(f"  ✗ Upload error: {e}")
            import traceback
            traceback.print_exc()
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

            print(f"  → Question: {question[:80]}...")
            print(f"  → Searching {len(chunks)} chunks...")

            query_embedding = get_embeddings([question], api_key=api_key)[0]
            semantic_chunks, early_chunks = retrieve_chunks(query_embedding, chunks, embeddings)

            print(f"  → Retrieved {len(semantic_chunks)} semantic + {len(early_chunks)} early-page chunks")
            print(f"  → Generating answer...")

            context = build_context(semantic_chunks, early_chunks)
            answer = generate_answer(question, context, history, api_key=api_key)

            sources = []
            for ec in early_chunks:
                sources.append({"text": ec["text"], "page": ec.get("page", "?"), "source": ec.get("source", "unknown")})
            for sc in semantic_chunks:
                sources.append({"text": sc["text"], "page": sc.get("page", "?"), "source": sc.get("source", "unknown")})

            print(f"  → Answer generated ({len(answer)} chars)")

            # Generate a short title for the chat if this is the first message
            suggested_title = None
            if is_first_message:
                try:
                    suggested_title = generate_chat_title(question, answer, api_key=api_key)
                    print(f"  → Suggested title: {suggested_title}")
                except Exception as e:
                    print(f"  ⚠ Title generation failed: {e}")

            response_data = {
                "answer": answer,
                "sources": sources,
            }
            if suggested_title:
                response_data["suggested_title"] = suggested_title

            self._send_json(200, response_data)

        except Exception as e:
            print(f"  ✗ Chat error: {e}")
            import traceback
            traceback.print_exc()
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

            print(f"  → Generating summary for {len(session['chunks'])} chunks...")

            summary = generate_summary(session["chunks"], session["filenames"], api_key=api_key)
            print(f"  → Summary generated ({len(summary)} chars)")

            self._send_json(200, {"summary": summary})

        except Exception as e:
            print(f"  ✗ Summary error: {e}")
            import traceback
            traceback.print_exc()
            self._send_json(500, {"error": str(e)})

    def log_message(self, format, *args):
        print(f"[API] {args[0]}")


def main():
    port = 3001
    server = HTTPServer(("0.0.0.0", port), DevHandler)
    print(f"\n🧠 RAG Assistant API (dev server)")
    print(f"   Running on http://localhost:{port}")
    print(f"   Endpoints:")
    print(f"     GET  /api        → Health check")
    print(f"     POST /api/upload     → Upload & index documents")
    print(f"     POST /api/chat      → Ask questions")
    print(f"     POST /api/summarize → AI document summary")
    print(f"   Limits: {MAX_FILE_SIZE_BYTES // (1024*1024)}MB/file, {MAX_FILES_PER_UPLOAD} files/upload")
    print(f"   Press Ctrl+C to stop\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n   Shutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
