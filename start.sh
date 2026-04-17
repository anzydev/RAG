#!/bin/bash

# RAG Assistant — Start both frontend and backend with one command
# Usage: ./start.sh

cd "$(dirname "$0")"

echo ""
echo "🧠 RAG Assistant — Starting..."
echo ""

# Kill any existing processes on our ports
lsof -ti:3001 2>/dev/null | xargs kill -9 2>/dev/null
lsof -ti:5173 2>/dev/null | xargs kill -9 2>/dev/null

# Start backend
echo "  → Starting backend on http://localhost:3001"
source venv/bin/activate
python dev_server.py &
BACKEND_PID=$!

# Start frontend
echo "  → Starting frontend on http://localhost:5173"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "  ✓ Both servers running!"
echo "  → Open http://localhost:5173"
echo "  → Press Ctrl+C to stop both"
echo ""

# Trap Ctrl+C to kill both
trap "echo ''; echo '  Shutting down...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM

# Wait for either to exit
wait
