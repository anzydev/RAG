import { useState, useRef, useEffect, useCallback } from "react";
import { ChatMessage } from "@/components/ui/chat-message";
import { LoadingScreen } from "@/components/ui/loading-screen";
import { Toast } from "@/components/ui/toast";
import { MicButton } from "@/components/ui/mic-button";
import { useAutoResizeTextarea } from "@/hooks/use-auto-resize";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
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
  MessageSquare,
  Menu,
  Star,
  Pencil,
  AlertTriangle
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
  isImportant?: boolean;
}

// ---- App ----
export default function App() {
  const [isAppLoading, setIsAppLoading] = useState(true);

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

  // Mobile sidebar
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Editing thread name
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  // Switch-chat warning modal
  const [showSwitchWarning, setShowSwitchWarning] = useState(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);

  // Toast notifications (replaces native alert())
  const [toast, setToast] = useState<{ message: string; type: "error" | "success" | "info" } | null>(null);
  const showToast = useCallback((message: string, type: "error" | "success" | "info" = "error") => {
    setToast({ message, type });
  }, []);

  // Input
  const [inputValue, setInputValue] = useState("");
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({
    minHeight: 24,
    maxHeight: 200,
  });

  // Speech recognition
  const {
    isSupported: micSupported,
    isListening,
    transcript,
    interimTranscript,
    error: micError,
    startListening,
    stopListening,
    resetTranscript,
  } = useSpeechRecognition();

  // Sync speech transcript → input box
  useEffect(() => {
    if (transcript) {
      setInputValue(transcript);
      adjustHeight();
      resetTranscript();
    }
  }, [transcript, adjustHeight, resetTranscript]);

  // Show mic errors as toasts
  useEffect(() => {
    if (micError) showToast(micError, "error");
  }, [micError, showToast]);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived state for the active thread
  const activeThread = threads.find(t => t.id === activeThreadId) || null;
  const messages = activeThread?.messages || [];
  const sessionId = activeThread?.sessionId || null;
  const chunkCount = activeThread?.chunkCount || 0;
  const filenames = activeThread?.filenames || [];
  const docsLoaded = !!sessionId;

  // Initial random loading sequence (4 to 5s)
  useEffect(() => {
    const randomMs = Math.floor(Math.random() * (5000 - 4000 + 1) + 4000);
    const timer = setTimeout(() => {
      setIsAppLoading(false);
    }, randomMs);
    return () => clearTimeout(timer);
  }, []);

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
      
      // Sort: important first, then by recently updated
      next.sort((a, b) => {
        if (a.isImportant && !b.isImportant) return -1;
        if (!a.isImportant && b.isImportant) return 1;
        return b.updatedAt - a.updatedAt;
      });
      
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

  const toggleImportant = (id: string) => {
    setThreads(prev => {
      const next = prev.map(t => t.id === id ? { ...t, isImportant: !t.isImportant } : t);
      // Re-sort after toggling
      next.sort((a, b) => {
        if (a.isImportant && !b.isImportant) return -1;
        if (!a.isImportant && b.isImportant) return 1;
        return b.updatedAt - a.updatedAt;
      });
      return next;
    });
  };

  // Chat switch with document warning
  const requestSwitchThread = (targetId: string | null) => {
    // If switching away from a chat that has documents, warn user
    if (activeThread?.sessionId && targetId !== activeThreadId) {
      setPendingSwitchId(targetId);
      setShowSwitchWarning(true);
    } else {
      setActiveThreadId(targetId);
      setShowSummary(false);
      setSummary(null);
      setSidebarOpen(false);
    }
  };

  const confirmSwitch = () => {
    setActiveThreadId(pendingSwitchId);
    setShowSummary(false);
    setSummary(null);
    setSidebarOpen(false);
    setShowSwitchWarning(false);
    setPendingSwitchId(null);
  };

  const cancelSwitch = () => {
    setShowSwitchWarning(false);
    setPendingSwitchId(null);
  };

  // Inline rename helpers
  const startEditing = (threadId: string, currentTitle: string) => {
    setEditingThreadId(threadId);
    setEditingTitle(currentTitle);
    setTimeout(() => editInputRef.current?.focus(), 50);
  };

  const saveEdit = () => {
    if (editingThreadId && editingTitle.trim()) {
      updateThread({ id: editingThreadId, title: editingTitle.trim() });
    }
    setEditingThreadId(null);
    setEditingTitle("");
  };

  const cancelEdit = () => {
    setEditingThreadId(null);
    setEditingTitle("");
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
      const msg = err.message || "Upload failed";
      if (msg.includes("Connection error")) {
        showToast("Could not connect to the embedding service. Please check your API key or try again later.", "error");
      } else {
        showToast(`Upload error: ${msg}`, "error");
      }
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
      showToast(`Summary error: ${err.message}`, "error");
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
      
      // Persist UI update first — use a temp title until AI suggests one
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
            is_first_message: isFirstMessage,
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
              // Auto-rename with AI-suggested title on first message
              title: data.suggested_title || next[idx].title,
              updatedAt: Date.now()
            };
            // Resort threads (important first, then by date)
            next.sort((a, b) => {
              if (a.isImportant && !b.isImportant) return -1;
              if (!a.isImportant && b.isImportant) return 1;
              return b.updatedAt - a.updatedAt;
            });
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
      showToast("Please upload a document first.", "info");
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

  if (isAppLoading) {
    return <LoadingScreen />;
  }

  return (
    <div className="h-dvh flex overflow-hidden bg-background">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.txt,.md"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* ===== MOBILE SIDEBAR OVERLAY ===== */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ===== SIDEBAR ===== */}
      <div className={cn(
        "w-[260px] bg-surface/50 border-r border-border flex flex-col shrink-0 transition-all duration-300",
        "fixed inset-y-0 left-0 z-50 md:static md:z-auto",
        sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
      )}>
        <div className="p-3 border-b border-border flex items-center gap-2">
          <button 
            onClick={() => requestSwitchThread(null)}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 bg-text-primary text-background rounded-xl text-sm font-semibold hover:opacity-90 transition-opacity shadow-sm"
          >
            <Plus className="w-4 h-4" />
            New Chat
          </button>
          {/* Close sidebar button (mobile only) */}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden w-10 h-10 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-4 space-y-1 custom-scrollbar">
          <p className="text-[11px] font-semibold tracking-wider text-text-secondary/50 px-2 py-1 mb-2 uppercase">Recent Chats</p>
          {threads.length === 0 && (
            <p className="text-[13px] text-text-secondary/60 px-2 mt-2">No history</p>
          )}
          {threads.map((t) => (
            <div
              key={t.id}
              onClick={() => { if (editingThreadId !== t.id) requestSwitchThread(t.id); }}
              className={cn(
                "w-full flex items-center justify-between group px-3 py-2.5 rounded-xl text-[13px] transition-all cursor-pointer",
                activeThreadId === t.id 
                  ? "bg-accent/15 text-accent font-medium shadow-[inset_0_1px_rgba(255,255,255,0.05)]" 
                  : "hover:bg-white/5 text-text-secondary hover:text-text-primary font-normal"
              )}
            >
              <div className="flex items-center gap-2.5 overflow-hidden min-w-0 flex-1">
                {/* Star icon for important */}
                <button
                  onClick={(e) => { e.stopPropagation(); toggleImportant(t.id); }}
                  className={cn(
                    "shrink-0 p-0.5 rounded transition-all",
                    t.isImportant 
                      ? "text-amber-400 opacity-100" 
                      : "text-text-secondary/40 opacity-0 group-hover:opacity-100 hover:text-amber-400"
                  )}
                  title={t.isImportant ? "Unmark important" : "Mark as important"}
                >
                  <Star className={cn("w-3.5 h-3.5", t.isImportant && "fill-amber-400")} />
                </button>

                {/* Inline edit or title display */}
                {editingThreadId === t.id ? (
                  <input
                    ref={editInputRef}
                    value={editingTitle}
                    onChange={(e) => setEditingTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); saveEdit(); }
                      if (e.key === "Escape") cancelEdit();
                    }}
                    onBlur={saveEdit}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 bg-background/80 border border-accent/40 rounded-md px-2 py-0.5 text-[13px] text-text-primary outline-none focus:border-accent min-w-0"
                  />
                ) : (
                  <span
                    className="truncate text-left"
                    onDoubleClick={(e) => { e.stopPropagation(); startEditing(t.id, t.title); }}
                  >
                    {t.title}
                  </span>
                )}
              </div>

              {/* Action buttons */}
              {editingThreadId !== t.id && (
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-all -mr-1">
                  <div
                    onClick={(e) => { e.stopPropagation(); startEditing(t.id, t.title); }}
                    className="p-1.5 hover:bg-white/10 rounded-md transition-all"
                    title="Rename chat"
                  >
                    <Pencil className="w-3.5 h-3.5 text-text-secondary hover:text-text-primary" />
                  </div>
                  <div 
                    onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}
                    className="p-1.5 hover:bg-white/10 rounded-md transition-all"
                    title="Delete this chat"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-text-secondary hover:text-red-400" />
                  </div>
                </div>
              )}
            </div>
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
      <main className="flex-1 flex flex-col min-w-0 bg-background w-full overflow-hidden">
        {/* Mobile top bar with hamburger */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-surface/30 shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="w-9 h-9 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          <h1 className="text-sm font-semibold text-text-primary truncate">
            {activeThread?.title || "RAG Assistant"}
          </h1>
        </div>
        {!hasMessages && !showSummary ? (
          /* ========== LANDING VIEW ========== */
          <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-4 pb-safe">
            <h1 className="text-base sm:text-2xl font-medium text-text-primary mb-5 sm:mb-8 animate-fade-in relative text-center px-2">
              {docsLoaded ? `${filenames.length} file${filenames.length !== 1 ? "s" : ""} ready. Ask anything.` : "Ready when you are."}
            </h1>

            {/* Input bar */}
            <div className="w-full max-w-[680px] animate-fade-in animate-delay-100 px-1">
              <div className="flex items-center bg-surface border border-border rounded-full px-1 py-1 sm:px-1.5 sm:py-1.5 transition-colors focus-within:border-border-hover shadow-[0_4px_24px_-12px_rgba(0,0,0,0.5)]">
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
                  value={isListening && interimTranscript ? interimTranscript : inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit();
                    }
                  }}
                  placeholder={isListening ? "Listening…" : docsLoaded ? "Ask anything" : "Upload a document to start..."}
                  className={cn(
                    "flex-1 bg-transparent border-none outline-none text-sm sm:text-[15px] px-2 sm:px-3",
                    isListening && interimTranscript
                      ? "text-text-secondary/70 placeholder:text-text-secondary/50"
                      : "text-text-primary placeholder:text-text-secondary/50"
                  )}
                />

                {/* Mic button */}
                <MicButton
                  isListening={isListening}
                  isSupported={micSupported}
                  disabled={chatLoading}
                  onStart={startListening}
                  onStop={stopListening}
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
              <div className="flex items-center gap-1.5 sm:gap-2 mt-4 sm:mt-6 flex-wrap justify-center animate-fade-in animate-delay-200 px-2">
                {filenames.map((name, i) => (
                  <span key={i} className="inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full bg-surface border border-border text-[11px] sm:text-[12px] text-text-secondary shadow-sm">
                    <FileText className="w-3 h-3 sm:w-3.5 sm:h-3.5 text-accent opacity-80" />
                    <span className="truncate max-w-[120px] sm:max-w-none">{name}</span>
                  </span>
                ))}
                <span className="text-[11px] sm:text-[12px] text-text-secondary/40 font-medium px-1">{chunkCount} chunks</span>
              </div>
            )}
          </div>
        ) : (
          /* ========== CHAT VIEW ========== */
          <>
            <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 sm:py-8 custom-scrollbar overscroll-contain">
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
            <div className="w-full bg-gradient-to-t from-background via-background/95 to-transparent pt-3 pb-3 sm:pt-6 sm:pb-6 px-3 sm:px-4 pb-safe">
              <div className="max-w-3xl mx-auto">
                <div className="flex items-end bg-surface border border-border rounded-2xl px-1.5 sm:px-2 py-1.5 sm:py-2 transition-colors focus-within:border-border-hover shadow-lg">
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
                    value={isListening && interimTranscript ? interimTranscript : inputValue}
                    onChange={(e) => {
                      setInputValue(e.target.value);
                      adjustHeight();
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder={isListening ? "Listening…" : "Message RAG Assistant..."}
                    disabled={chatLoading}
                    rows={1}
                    className={cn(
                      "flex-1 bg-transparent border-none outline-none text-sm sm:text-[15px] px-2 sm:px-3 py-2 sm:py-2.5 resize-none min-h-[40px] sm:min-h-[44px] max-h-[200px] sm:max-h-[300px] focus:outline-none focus-visible:ring-0 custom-scrollbar placeholder:text-text-secondary/50",
                      isListening && interimTranscript ? "text-text-secondary/70" : "text-text-primary"
                    )}
                  />

                  {/* Mic button */}
                  <MicButton
                    isListening={isListening}
                    isSupported={micSupported}
                    disabled={chatLoading}
                    onStart={startListening}
                    onStop={stopListening}
                    className="mb-0.5"
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
                <p className="text-center text-[10px] sm:text-[11px] text-text-secondary/40 mt-2 sm:mt-3 font-medium">
                  Answers generated by RAG Engine · Powered by document context
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

      {/* Switch-chat warning modal */}
      {showSwitchWarning && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm" onClick={cancelSwitch}>
          <div
            className="bg-surface border border-border rounded-2xl p-6 max-w-md w-full mx-4 animate-fade-in shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center border border-amber-500/20">
                <AlertTriangle className="w-5 h-5 text-amber-400" />
              </div>
              <h3 className="text-text-primary font-semibold text-lg">Switch Chat?</h3>
            </div>
            <p className="text-[13px] text-text-secondary leading-relaxed mb-6 ml-[3.25rem]">
              Your uploaded document history is tied to the current chat session. Switching chats may require re-uploading documents for the new conversation.
            </p>
            <div className="flex gap-2 ml-[3.25rem]">
              <button
                onClick={confirmSwitch}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-sm font-semibold transition-all shadow-sm hover:shadow-md active:scale-[0.98]"
              >
                Continue
              </button>
              <button
                onClick={cancelSwitch}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-border hover:border-border-hover text-text-secondary hover:text-text-primary text-sm font-medium transition-colors"
              >
                Stay Here
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onClose={() => setToast(null)}
        />
      )}
    </div>
  );
}
