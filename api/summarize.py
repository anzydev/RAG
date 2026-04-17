"""
Summarize endpoint — generates AI summary of uploaded documents.
POST /api/summarize
Body: { session_id }
Returns: { summary }
"""
from http.server import BaseHTTPRequestHandler
import json

import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from _lib.rag_engine import generate_summary
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

            session_id = body.get("session_id", "")
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

    def _send_json(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)
