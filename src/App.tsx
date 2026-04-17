import { useState, useRef, useEffect, useCallback } from "react";
import { ChatMessage } from "@/components/ui/chat-message";
import { useAutoResizeTextarea } from "@/hooks/use-auto-resize";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import {
  Plus,
  ArrowUp,
  ScrollText,
  X,
  Loader2,
  FileText,
  Key,
  Check,
  Trash2,
} from "lucide-react";

// ---- Helpers ----
async function safeJson(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) {
    throw new Error("Empty response from server. Is the backend running on port 3001?");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Server returned an invalid response. Is the backend running on port 3001?");
  }
}

// ---- Types ----
interface Source {
  text: string;
  page: number | string;
  source?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
}

// ---- App ----
export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState(0);
  const [filenames, setFilenames] = useState<string[]>([]);
  const [docsLoaded, setDocsLoaded] = useState(false);

  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [chatLoading, setChatLoading] = useState(false);

  // Summary
  const [summary, setSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [showSummary, setShowSummary] = useState(false);

  // API Key
  const [customApiKey, setCustomApiKey] = useState(() =>
    localStorage.getItem("rag_api_key") || ""
  );
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");

  // Input
  const [inputValue, setInputValue] = useState("");
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({
    minHeight: 24,
    maxHeight: 200,
  });

  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatLoading]);

  // Build headers with optional API key
  const getHeaders = useCallback((json = true) => {
    const headers: Record<string, string> = {};
    if (json) headers["Content-Type"] = "application/json";
    if (customApiKey) headers["X-Api-Key"] = customApiKey;
    return headers;
  }, [customApiKey]);

  // ---- API Key ----
  const handleSaveApiKey = () => {
    const key = apiKeyInput.trim();
    setCustomApiKey(key);
    if (key) {
      localStorage.setItem("rag_api_key", key);
    } else {
      localStorage.removeItem("rag_api_key");
    }
    setShowApiKeyModal(false);
  };

  const handleRemoveApiKey = () => {
    setCustomApiKey("");
    setApiKeyInput("");
    localStorage.removeItem("rag_api_key");
    setShowApiKeyModal(false);
  };

  // ---- Upload ----
  const handleUpload = useCallback(async (files: File[]) => {
    setUploading(true);
    setUploadProgress(5);
    try {
      const formData = new FormData();
      files.forEach((file) => formData.append("files", file));
      setUploadProgress(10);
      const progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 85) return prev;
          return Math.min(85, prev + Math.random() * (prev < 50 ? 5 : 2));
        });
      }, 800);

      const fetchHeaders: Record<string, string> = {};
      if (customApiKey) fetchHeaders["X-Api-Key"] = customApiKey;

      const res = await fetch("/api/upload", {
        method: "POST",
        headers: fetchHeaders,
        body: formData,
      });
      clearInterval(progressInterval);
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Upload failed");
      setUploadProgress(95);
      setSessionId(data.session_id);
      setChunkCount(data.chunk_count);
      setFilenames((prev) => [...prev, ...data.filenames.filter((n: string) => !prev.includes(n))]);
      setDocsLoaded(true);
      setUploadProgress(100);
    } catch (err: any) {
      alert(`Upload error: ${err.message}`);
    } finally {
      setTimeout(() => { setUploading(false); setUploadProgress(0); }, 500);
    }
  }, [customApiKey]);

  // ---- Summary ----
  const handleGenerateSummary = useCallback(async () => {
    if (!sessionId) return;
    setSummaryLoading(true);
    try {
      const res = await fetch("/api/summarize", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await safeJson(res);
      if (!res.ok) throw new Error(data.error || "Failed");
      setSummary(data.summary);
      setShowSummary(true);
    } catch (err: any) {
      alert(`Summary error: ${err.message}`);
    } finally {
      setSummaryLoading(false);
    }
  }, [sessionId, getHeaders]);

  // ---- Chat ----
  const handleSend = useCallback(
    async (question: string) => {
      setMessages((prev) => [...prev, { role: "user", content: question }]);
      setChatLoading(true);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            question,
            session_id: sessionId,
            history: messages.slice(-6).map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        const data = await safeJson(res);
        if (!res.ok) throw new Error(data.error || "Failed");
        setMessages((prev) => [...prev, { role: "assistant", content: data.answer, sources: data.sources }]);
      } catch (err: any) {
        setMessages((prev) => [...prev, { role: "assistant", content: `Error: ${err.message}` }]);
      } finally {
        setChatLoading(false);
      }
    },
    [sessionId, messages, getHeaders]
  );

  const handleSubmit = () => {
    if (!inputValue.trim() || chatLoading) return;
    if (!docsLoaded || !sessionId) {
      alert("Please upload a document first.");
      return;
    }
    handleSend(inputValue.trim());
    setInputValue("");
    adjustHeight(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleReindex = () => {
    setSessionId(null);
    setChunkCount(0);
    setFilenames([]);
    setDocsLoaded(false);
    setMessages([]);
    setSummary(null);
    setShowSummary(false);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      handleUpload(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="h-screen flex overflow-hidden bg-background">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.txt,.md"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* ---- Main content ---- */}
      <main className="flex-1 flex flex-col min-w-0">
        {!hasMessages && !showSummary ? (
          /* ========== LANDING VIEW ========== */
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <h1 className="text-2xl font-medium text-text-primary mb-8">
              {docsLoaded ? `${filenames.length} file${filenames.length !== 1 ? "s" : ""} ready. Ask anything.` : "Ready when you are."}
            </h1>

            {/* Input bar */}
            <div className="w-full max-w-[680px]">
              <div className="flex items-center bg-surface border border-border rounded-full px-1.5 py-1.5 transition-colors focus-within:border-border-hover">
                {/* + button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-9 h-9 rounded-full flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors shrink-0"
                >
                  <Plus className="w-5 h-5" />
                </button>

                {/* Text input */}
                <input
                  type="text"
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder={docsLoaded ? "Ask anything" : "Upload a document to start..."}
                  className="flex-1 bg-transparent border-none outline-none text-text-primary text-sm placeholder:text-text-secondary/60 px-2"
                />

                {/* Send button */}
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!inputValue.trim() || chatLoading}
                  className={cn(
                    "w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all",
                    docsLoaded && inputValue.trim()
                      ? "bg-text-primary text-background"
                      : "bg-white/10 text-text-secondary"
                  )}
                >
                  {chatLoading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <ArrowUp className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {/* File info chips */}
            {docsLoaded && (
              <div className="flex items-center gap-2 mt-4 flex-wrap justify-center">
                {filenames.map((name, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface border border-border text-[11px] text-text-secondary">
                    <FileText className="w-3 h-3" />
                    {name}
                  </span>
                ))}
                <span className="text-[11px] text-text-secondary/50">{chunkCount} chunks</span>
              </div>
            )}
          </div>
        ) : (
          /* ========== CHAT VIEW ========== */
          <>
            <div className="flex-1 overflow-y-auto px-4 py-6">
              <div className="max-w-3xl mx-auto space-y-4">
                {/* Summary panel */}
                {showSummary && summary && (
                  <div className="bg-surface border border-border rounded-2xl p-5 animate-slide-up">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <ScrollText className="w-4 h-4 text-emerald-400" />
                        <h3 className="text-sm font-semibold text-text-primary">AI Summary</h3>
                      </div>
                      <button onClick={() => setShowSummary(false)} className="p-1 hover:bg-white/5 rounded-lg transition-colors">
                        <X className="w-4 h-4 text-text-secondary" />
                      </button>
                    </div>
                    <div className="markdown-content text-sm text-text-secondary">
                      <ReactMarkdown>{summary}</ReactMarkdown>
                    </div>
                  </div>
                )}

                {messages.map((msg, i) => (
                  <ChatMessage key={i} role={msg.role} content={msg.content} sources={msg.sources} />
                ))}

                {chatLoading && <ChatMessage role="assistant" content="" isLoading />}
                <div ref={chatEndRef} />
              </div>
            </div>

            {/* ---- Bottom input bar ---- */}
            <div className="sticky bottom-0 w-full bg-gradient-to-t from-background via-background to-transparent pt-4 pb-4 px-4">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-end bg-surface border border-border rounded-2xl px-1.5 py-1.5 transition-colors focus-within:border-border-hover">
                  {/* + button */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-9 h-9 rounded-full flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors shrink-0 mb-0.5"
                  >
                    <Plus className="w-5 h-5" />
                  </button>

                  {/* Textarea */}
                  <textarea
                    ref={textareaRef}
                    value={inputValue}
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      adjustHeight();
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything"
                    disabled={chatLoading}
                    rows={1}
                    className="flex-1 bg-transparent border-none outline-none text-text-primary text-sm placeholder:text-text-secondary/60 px-2 py-2 resize-none min-h-[24px] max-h-[200px] focus:outline-none focus-visible:ring-0"
                    style={{ overflow: "hidden" }}
                  />

                  {/* Send */}
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!inputValue.trim() || chatLoading}
                    className={cn(
                      "w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-all mb-0.5",
                      inputValue.trim() && !chatLoading
                        ? "bg-text-primary text-background"
                        : "bg-white/10 text-text-secondary"
                    )}
                  >
                    {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-center text-[11px] text-text-secondary/40 mt-2">
                  RAG Assistant · Answers grounded in your documents
                </p>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ===== API Key button (bottom-left) ===== */}
      <button
        onClick={() => {
          setApiKeyInput(customApiKey);
          setShowApiKeyModal(true);
        }}
        className={cn(
          "fixed bottom-4 left-4 z-40 flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-medium transition-all duration-200",
          customApiKey
            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
            : "bg-surface border-border text-text-secondary hover:text-text-primary hover:border-border-hover"
        )}
      >
        <Key className="w-3.5 h-3.5" />
        {customApiKey ? "API Key ✓" : "API Key"}
      </button>

      {/* ===== API Key Modal ===== */}
      {showApiKeyModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setShowApiKeyModal(false)}>
          <div
            className="bg-surface border border-border rounded-2xl p-6 max-w-md w-full mx-4 animate-fade-in"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-accent/15 flex items-center justify-center">
                  <Key className="w-4 h-4 text-accent" />
                </div>
                <h3 className="text-text-primary font-semibold">API Key</h3>
              </div>
              <button onClick={() => setShowApiKeyModal(false)} className="p-1.5 hover:bg-white/5 rounded-lg transition-colors">
                <X className="w-4 h-4 text-text-secondary" />
              </button>
            </div>

            <p className="text-xs text-text-secondary mb-4 ml-10">
              Use your own <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-accent hover:underline">OpenRouter</a> API key. Your key is stored locally and never sent to our servers.
            </p>

            <div className="space-y-3">
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveApiKey(); }}
                placeholder="sk-or-v1-..."
                className="w-full bg-background border border-border rounded-xl px-4 py-2.5 text-sm text-text-primary placeholder:text-text-secondary/40 outline-none focus:border-accent transition-colors"
                autoFocus
              />

              <div className="flex gap-2">
                <button
                  onClick={handleSaveApiKey}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-sm font-medium transition-colors"
                >
                  <Check className="w-3.5 h-3.5" />
                  Save Key
                </button>

                {customApiKey && (
                  <button
                    onClick={handleRemoveApiKey}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border hover:border-red-500/40 text-text-secondary hover:text-red-400 text-sm transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Remove
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload progress overlay */}
      {uploading && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-surface border border-border rounded-2xl p-8 max-w-md w-full mx-4 animate-fade-in">
            <div className="flex items-center gap-3 mb-4">
              <Loader2 className="w-5 h-5 text-accent animate-spin" />
              <h3 className="text-text-primary font-medium">Processing document...</h3>
            </div>
            <div className="w-full bg-background rounded-full h-2 mb-2">
              <div
                className="bg-gradient-to-r from-accent to-emerald-500 h-2 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-xs text-text-secondary">
              {uploadProgress < 30 ? "Extracting text..." : uploadProgress < 60 ? "Chunking & indexing..." : uploadProgress < 85 ? "Generating embeddings (this may take a moment)..." : "Almost done..."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
