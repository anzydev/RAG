import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface MicButtonProps {
  isListening: boolean;
  isSupported: boolean;
  disabled?: boolean;
  onStart: () => void;
  onStop: () => void;
  className?: string;
}

export function MicButton({
  isListening,
  isSupported,
  disabled = false,
  onStart,
  onStop,
  className,
}: MicButtonProps) {
  if (!isSupported) return null;

  const handleClick = () => {
    if (disabled) return;
    if (isListening) onStop();
    else onStart();
  };

  return (
    <button
      type="button"
      id="mic-button"
      onClick={handleClick}
      disabled={disabled}
      title={isListening ? "Stop recording" : "Speak your question"}
      aria-label={isListening ? "Stop voice input" : "Start voice input"}
      className={cn(
        "relative flex items-center justify-center shrink-0 rounded-full transition-all duration-200 w-10 h-10",
        isListening
          ? "text-red-400 bg-red-500/10 hover:bg-red-500/20 mic-pulse"
          : "text-text-secondary hover:text-text-primary hover:bg-white/5",
        disabled && "opacity-40 cursor-not-allowed",
        className
      )}
    >
      {isListening ? (
        <MicOff className="w-4 h-4" />
      ) : (
        <Mic className="w-4 h-4" />
      )}
    </button>
  );
}
