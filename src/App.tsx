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
  MessageSquare
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

interface ChatThread {
  id: string;
  title: string;
  sessionId: string;
  messages: Message[];
  filenames: string[];
  chunkCount: number;
  updatedAt: number;
}

// ---- App ----
export default function App() {
  const [threads, setThreads] = useState<ChatThread[]>(() => {
    try { return JSON.parse(localStorage.getItem("rag_threads") || "[]"); }
    catch { return []; }
  });
  const [activeThreadId, setActiveThreadId] = useState<string | null>(() => localStorage.getItem("rag_active_thread_id"));

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
  const [saveToLocal, setSaveToLocal] = useState(true);

  // Input
  const [inputValue, setInputValue] = useState("");
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({
    minHeight: 24,
    maxHeight: 200,
  });

  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived state for the active thread
  const activeThread = threads.find(t => t.id === activeThreadId) || null;
  const messages = activeThread?.messages || [];
  const sessionId = activeThread?.sessionId || null;
  const chunkCount = activeThread?.chunkCount || 0;
  const filenames = activeThread?.filenames || [];
  const docsLoaded = !!sessionId;

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, chatLoading]);

  // Persist top-level state to localStorage
  useEffect(() => {
    localStorage.setItem("rag_threads", JSON.stringify(threads));
    if (activeThreadId) {
      localStorage.setItem("rag_active_thread_id", activeThreadId);
    } else {
      localStorage.removeItem("rag_active_thread_id");
    }
  }, [threads, activeThreadId]);

  // Clean obsolete fields from previous versions (Cleanup migration)
  useEffect(() => {
    const legacyKeys = ["rag_messages", "rag_session_id", "rag_chunk_count", "rag_filenames", "rag_docs_loaded"];
    legacyKeys.forEach(k => localStorage.removeItem(k));
  }, []);

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
    if (key && saveToLocal) {
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

  // ---- Thread Logic ----
  const updateThread = useCallback((threadData: Partial<ChatThread> & { id: string }) => {
    setThreads(prev => {
      let next = [...prev];
      const idx = next.findIndex(t => t.id === threadData.id);
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...threadData, updatedAt: Date.now() };
      } else {
        next.unshift({
           title: "New Chat",
           sessionId: "",
           messages: [],
           filenames: [],
           chunkCount: 0,
           updatedAt: Date.now(),
           ...threadData
        } as ChatThread);
      }
      
      // Sort by recently updated
      next.sort((a, b) => b.updatedAt - a.updatedAt);
      
      // Maintain strictly rolling 5 limit max
      if (next.length > 5) {
        next = next.slice(0, 5);
      }
      return next;
    });
  }, []);

  const deleteThread = (id: string) => {
    setThreads(prev => prev.filter(t => t.id !== id));
    if (activeThreadId === id) setActiveThreadId(null);
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

      // Thread resolution
      const targetId = activeThreadId || Date.now().toString();
      const currentNames = activeThread?.filenames || [];
      const combinedNames = Array.from(new Set([...currentNames, ...data.filenames]));

      updateThread({
        id: targetId,
        sessionId: data.session_id,
        filenames: combinedNames,
        chunkCount: data.chunk_count,
        title: activeThread?.title && activeThread.title !== "New Chat" ? activeThread.title : data.filenames[0]
      });

      if (!activeThreadId) {
        setActiveThreadId(targetId);
      }
      setUploadProgress(100);
    } catch (err: any) {
      alert(`Upload error: ${err.message}`);
    } finally {
      setTimeout(() => { setUploading(false); setUploadProgress(0); }, 500);
    }
  }, [customApiKey, activeThreadId, activeThread, updateThread]);

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
      if (!sessionId || !activeThreadId) return;

      const isFirstMessage = messages.length === 0;
      const newMessagesForUi = [...messages, { role: "user", content: question } as Message];
      
      // Persist UI update first
      updateThread({
        id: activeThreadId,
        messages: newMessagesForUi,
        title: isFirstMessage ? question.slice(0, 30) + (question.length > 30 ? "..." : "") : activeThread?.title
      });
      
      setChatLoading(true);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({
            question,
            session_id: sessionId,
            history: newMessagesForUi.slice(-6).map((m) => ({ role: m.role, content: m.content })),
          }),
        });
        const data = await safeJson(res);
        if (!res.ok) throw new Error(data.error || "Failed");
        
        // Push assistant answer into existing array via functional state
        setThreads(prev => {
          let next = [...prev];
          const idx = next.findIndex(t => t.id === activeThreadId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              messages: [...next[idx].messages, { role: "assistant", content: data.answer, sources: data.sources }],
              updatedAt: Date.now()
            };
            // Resort threads
            next.sort((a,b) => b.updatedAt - a.updatedAt);
          }
          return next;
        });

      } catch (err: any) {
        setThreads(prev => {
          let next = [...prev];
          const idx = next.findIndex(t => t.id === activeThreadId);
          if (idx >= 0) {
            next[idx] = {
              ...next[idx],
              messages: [...next[idx].messages, { role: "assistant", content: `Error: ${err.message}` }],
              updatedAt: Date.now()
            };
          }
          return next;
        });
      } finally {
        setChatLoading(false);
      }
    },
    [sessionId, activeThreadId, messages, activeThread, getHeaders, updateThread]
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

      {/* ===== SIDEBAR ===== */}
      <div className="w-[260px] bg-surface/50 border-r border-border flex flex-col shrink-0 transition-all duration-300">
        <div className="p-3 border-b border-border">
          <button 
            onClick={() => {
               setActiveThreadId(null);
               setShowSummary(false);
               setSummary(null);
            }}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-text-primary text-background rounded-xl text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-4 space-y-1 custom-scrollbar">
          <p className="text-[11px] font-semibold tracking-wider text-text-secondary/50 px-2 py-1 mb-2 uppercase">Recent Chats</p>
          {threads.length === 0 && (
            <p className="text-[13px] text-text-secondary/60 px-2 mt-2">No history</p>
          )}
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveThreadId(t.id)}
              className={cn(
                "w-full flex items-center justify-between group px-3 py-2.5 rounded-xl text-[13px] transition-all",
                activeThreadId === t.id 
                  ? "bg-accent/15 text-accent font-medium shadow-[inset_0_1px_rgba(255,255,255,0.05)]" 
                  : "hover:bg-white/5 text-text-secondary hover:text-text-primary font-normal"
              )}
            >
              <div className="flex items-center gap-2.5 overflow-hidden">
                <MessageSquare className="w-4 h-4 shrink-0 opacity-70" />
                <span className="truncate text-left">{t.title}</span>
              </div>
              <div 
                onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}
                className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-white/10 rounded-md transition-all shrink-0 -mr-1"
                title="Delete this chat"
              >
                <Trash2 className="w-3.5 h-3.5 text-text-secondary hover:text-red-400" />
              </div>
            </button>
          ))}
        </div>
        {/* API logic shifted to bottom of sidebar */}
        <div className="p-3 border-t border-border bg-surface/50">
          <button
            onClick={() => {
              setApiKeyInput(customApiKey);
              setShowApiKeyModal(true);
            }}
            className={cn(
              "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all duration-200",
              customApiKey
                ? "bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20"
                : "hover:bg-white/5 text-text-secondary hover:text-text-primary"
            )}
          >
            <Key className="w-4 h-4 shrink-0 opacity-80" />
            <span className="truncate">{customApiKey ? "API Key Active" : "Set API Key"}</span>
          </button>
        </div>
      </div>

      {/* ===== MAIN CONTENT View ===== */}
      <main className="flex-1 flex flex-col min-w-0 bg-background">
        {!hasMessages && !showSummary ? (
          /* ========== LANDING VIEW ========== */
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <h1 className="text-2xl font-medium text-text-primary mb-8 animate-fade-in relative">
              {docsLoaded ? `${filenames.length} file${filenames.length !== 1 ? "s" : ""} ready. Ask anything.` : "Ready when you are."}
            </h1>

            {/* Input bar */}
            <div className="w-full max-w-[680px] animate-fade-in animate-delay-100">
              <div className="flex items-center bg-surface border border-border rounded-full px-1.5 py-1.5 transition-colors focus-within:border-border-hover shadow-[0_4px_24px_-12px_rgba(0,0,0,0.5)]">
                {/* + button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="w-10 h-10 rounded-full flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors shrink-0"
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
                  className="flex-1 bg-transparent border-none outline-none text-text-primary text-[15px] placeholder:text-text-secondary/50 px-3"
                />

                {/* Send button */}
                <button
                  type="button"
                  onClick={handleSubmit}
                  disabled={!inputValue.trim() || chatLoading}
                  className={cn(
                    "w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-all shadow-sm",
                    docsLoaded && inputValue.trim()
                      ? "bg-text-primary text-background hover:scale-105 active:scale-95"
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
              <div className="flex items-center gap-2 mt-6 flex-wrap justify-center animate-fade-in animate-delay-200">
                {filenames.map((name, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface border border-border text-[12px] text-text-secondary shadow-sm">
                    <FileText className="w-3.5 h-3.5 text-accent opacity-80" />
                    {name}
                  </span>
                ))}
                <span className="text-[12px] text-text-secondary/40 font-medium px-1">{chunkCount} chunks</span>
              </div>
            )}
          </div>
        ) : (
          /* ========== CHAT VIEW ========== */
          <>
            <div className="flex-1 overflow-y-auto px-4 py-8 custom-scrollbar">
              <div className="max-w-3xl mx-auto space-y-6">
                {/* Summary panel */}
                {showSummary && summary && (
                  <div className="bg-surface/60 border border-border/60 rounded-2xl p-6 animate-slide-up shadow-sm">
                    <div className="flex items-center justify-between mb-4 pb-3 border-b border-border/40">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                          <ScrollText className="w-4 h-4 text-emerald-400" />
                        </div>
                        <h3 className="text-sm font-semibold text-text-primary">AI Summary</h3>
                      </div>
                      <button onClick={() => setShowSummary(false)} className="p-1.5 hover:bg-white/10 rounded-lg transition-colors">
                        <X className="w-4 h-4 text-text-secondary hover:text-text-primary" />
                      </button>
                    </div>
                    <div className="markdown-content text-sm text-text-secondary leading-relaxed">
                      <ReactMarkdown>{summary}</ReactMarkdown>
                    </div>
                  </div>
                )}

                {messages.map((msg, i) => (
                  <ChatMessage key={i} role={msg.role} content={msg.content} sources={msg.sources} />
                ))}

                {chatLoading && <ChatMessage role="assistant" content="" isLoading />}
                <div ref={chatEndRef} className="h-4" />
              </div>
            </div>

            {/* ---- Bottom input bar ---- */}
            <div className="w-full bg-gradient-to-t from-background via-background/95 to-transparent pt-6 pb-6 px-4">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-end bg-surface border border-border rounded-2xl px-2 py-2 transition-colors focus-within:border-border-hover shadow-lg">
                  {/* + button */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="w-10 h-10 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-white/10 transition-colors shrink-0 mb-0.5"
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
                    placeholder="Message RAG Assistant..."
                    disabled={chatLoading}
                    rows={1}
                    className="flex-1 bg-transparent border-none outline-none text-text-primary text-[15px] placeholder:text-text-secondary/50 px-3 py-2.5 resize-none min-h-[44px] max-h-[300px] focus:outline-none focus-visible:ring-0 custom-scrollbar"
                  />

                  {/* Send */}
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!inputValue.trim() || chatLoading}
                    className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all mb-0.5",
                      inputValue.trim() && !chatLoading
                        ? "bg-text-primary text-background hover:scale-[1.02] active:scale-95 shadow-sm"
                        : "bg-white/5 text-text-secondary/50"
                    )}
                  >
                    {chatLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUp className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-center text-[11px] text-text-secondary/40 mt-3 font-medium">
                  Answers generated by RAG Engine · Content strict formulation enabled 
                </p>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ===== API Key Modal ===== */}
      {showApiKeyModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm" onClick={() => setShowApiKeyModal(false)}>
          <div
            className="bg-surface border border-border rounded-2xl p-6 max-w-md w-full mx-4 animate-fade-in shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent/15 flex items-center justify-center border border-accent/20">
                  <Key className="w-5 h-5 text-accent" />
                </div>
                <h3 className="text-text-primary font-semibold text-lg">API Key</h3>
              </div>
              <button 
                onClick={() => setShowApiKeyModal(false)} 
                className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-text-secondary hover:text-text-primary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[13px] text-text-secondary mb-5 ml-[3.25rem] leading-relaxed">
              Use your own <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-accent hover:text-accent-hover underline underline-offset-2 transition-colors">OpenRouter</a> API key. Your key is stored securely in your browser's local storage and never leaves your device.
            </p>

            <div className="space-y-4">
              <div className="relative">
                <input
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleSaveApiKey(); }}
                  placeholder="sk-or-v1-..."
                  className="w-full bg-background border border-border rounded-xl px-4 py-3 pl-10 text-sm text-text-primary placeholder:text-text-secondary/40 outline-none focus:border-accent transition-all shadow-inner"
                  autoFocus
                />
                <Key className="w-4 h-4 text-text-secondary/50 absolute left-4 top-1/2 -translate-y-1/2" />
              </div>

              <label className="flex items-center gap-3 px-1 cursor-pointer">
                <div className="relative flex items-center justify-center">
                  <input
                    type="checkbox"
                    checked={saveToLocal}
                    onChange={(e) => setSaveToLocal(e.target.checked)}
                    className="peer w-5 h-5 rounded border-border text-accent focus:ring-accent bg-background cursor-pointer appearance-none checked:border-accent checked:bg-accent transition-colors"
                  />
                  <Check className="w-3.5 h-3.5 text-white absolute pointer-events-none opacity-0 peer-checked:opacity-100 transition-opacity" />
                </div>
                <span className="text-[13px] font-medium text-text-secondary select-none">Save key to local storage</span>
              </label>

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSaveApiKey}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent hover:bg-accent-hover text-white text-sm font-semibold transition-all shadow-sm hover:shadow-md active:scale-[0.98]"
                >
                  <Check className="w-4 h-4" />
                  Save Key
                </button>

                {customApiKey && (
                  <button
                    onClick={handleRemoveApiKey}
                    className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border hover:border-red-500/40 text-text-secondary hover:text-red-400 text-sm font-medium transition-colors hover:bg-red-500/5"
                  >
                    <Trash2 className="w-4 h-4" />
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
          <div className="bg-surface border border-border rounded-2xl p-8 max-w-md w-full mx-4 animate-fade-in shadow-2xl">
            <div className="flex items-center gap-4 mb-5">
              <div className="w-10 h-10 rounded-full bg-accent/15 flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-accent animate-spin" />
              </div>
              <h3 className="text-text-primary font-semibold text-lg">Processing document...</h3>
            </div>
            <div className="w-full bg-background rounded-full h-2 mb-3 shadow-inner overflow-hidden">
              <div
                className="bg-gradient-to-r from-accent to-emerald-500 h-full rounded-full transition-all duration-500 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <p className="text-[13px] text-text-secondary font-medium pl-1">
              {uploadProgress < 30 ? "Extracting text structure..." : uploadProgress < 60 ? "Indexing chunks..." : uploadProgress < 85 ? "Deploying embeddings (this takes a moment)..." : "Finalizing..."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
