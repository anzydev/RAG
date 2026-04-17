import { useState } from "react";
import { ChevronDown, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";

interface Source {
  text: string;
  page: number | string;
  source?: string;
}

interface SourcesPanelProps {
  sources: Source[];
  maxVisible?: number;
}

export function SourcesPanel({ sources, maxVisible = 5 }: SourcesPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const displayed = sources.slice(0, maxVisible);

  return (
    <div className="border-t border-border/50 pt-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 text-xs text-text-secondary hover:text-text-primary transition-colors duration-200 w-full"
      >
        <BookOpen className="w-3.5 h-3.5" />
        <span>
          {sources.length} source{sources.length !== 1 ? "s" : ""} referenced
        </span>
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 ml-auto transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>

      {isOpen && (
        <div className="mt-2 space-y-2 animate-fade-in">
          {displayed.map((source, i) => (
            <div
              key={i}
              className="bg-background/50 border border-border/50 rounded-lg p-3 text-xs"
            >
              <div className="flex items-center gap-1.5 mb-1.5 flex-wrap">
                {source.source && (
                  <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 text-[10px] font-medium">
                    {source.source}
                  </span>
                )}
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-accent/10 text-accent text-[10px] font-medium">
                  Page {source.page}
                </span>
              </div>
              <p className="text-text-secondary leading-relaxed line-clamp-4">
                {source.text.slice(0, 300)}
                {source.text.length > 300 ? "..." : ""}
              </p>
            </div>
          ))}
          {sources.length > maxVisible && (
            <p className="text-[10px] text-text-secondary/60 text-center">
              +{sources.length - maxVisible} more sources
            </p>
          )}
        </div>
      )}
    </div>
  );
}
