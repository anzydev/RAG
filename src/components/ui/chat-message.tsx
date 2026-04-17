import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";
import { SourcesPanel } from "./sources-panel";
import { Brain, User } from "lucide-react";

interface Source {
  text: string;
  page: number | string;
}

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  isLoading?: boolean;
}

export function ChatMessage({ role, content, sources, isLoading }: ChatMessageProps) {
  const isUser = role === "user";

  return (
    <div
      className={cn(
        "flex gap-3 animate-slide-up",
        isUser ? "flex-row-reverse" : "flex-row"
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          "flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-sm",
          isUser
            ? "bg-accent/15 text-accent"
            : "bg-emerald-500/15 text-emerald-400"
        )}
      >
        {isUser ? <User className="w-4 h-4" /> : <Brain className="w-4 h-4" />}
      </div>

      {/* Message bubble */}
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm",
          isUser
            ? "bg-accent/10 border border-accent/20 text-text-primary"
            : "bg-surface border border-border text-text-primary"
        )}
      >
        {isLoading ? (
          <div className="flex items-center gap-1.5 py-1 px-1">
            <div className="typing-dot w-2 h-2 rounded-full bg-text-secondary" />
            <div className="typing-dot w-2 h-2 rounded-full bg-text-secondary" />
            <div className="typing-dot w-2 h-2 rounded-full bg-text-secondary" />
          </div>
        ) : (
          <>
            <div className="markdown-content">
              <ReactMarkdown>{content}</ReactMarkdown>
            </div>
            {sources && sources.length > 0 && (
              <div className="mt-3">
                <SourcesPanel sources={sources} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
