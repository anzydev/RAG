"""
Upload endpoint — accepts file uploads, extracts text, chunks, embeds.
POST /api/upload
Returns: { session_id, filenames, chunk_count }
"""
from http.server import BaseHTTPRequestHandler
import json
import uuid
import email.parser
import email.policy

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from _lib.rag_engine import extract_and_chunk, get_embeddings
from _lib.session_store import save_session, cleanup_expired_sessions
from _lib.config import MAX_FILE_SIZE_BYTES, MAX_FILES_PER_UPLOAD


def _parse_multipart(content_type: str, body: bytes):
    """Parse multipart/form-data using the email module."""
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
    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Api-Key")
        self.send_header("Access-Control-Max-Age", "86400")
        self.end_headers()

    def do_POST(self):
        try:
            content_type = self.headers.get("Content-Type", "")
            api_key = (self.headers.get("X-Api-Key") or "").strip() or None

            if "multipart/form-data" not in content_type:
                self._send_json(400, {"error": "Expected multipart/form-data"})
                return

            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            files = _parse_multipart(content_type, body)

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
                    self._send_json(400, {"error": f"File '{filename}' exceeds the {MAX_FILE_SIZE_BYTES // (1024*1024)}MB size limit."})
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

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
