import { useEffect, useState } from "react";
import { X, AlertCircle, CheckCircle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToastProps {
  message: string;
  type?: "error" | "success" | "info";
  duration?: number;
  onClose: () => void;
}

export function Toast({ message, type = "error", duration = 5000, onClose }: ToastProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    requestAnimationFrame(() => setIsVisible(true));

    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onClose, 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const handleClose = () => {
    setIsExiting(true);
    setTimeout(onClose, 300);
  };

  const icon = {
    error: <AlertCircle className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />,
    success: <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />,
    info: <Info className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />,
  }[type];

  const colorClasses = {
    error: "bg-red-500/10 border-red-500/30 text-red-400",
    success: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400",
    info: "bg-blue-500/10 border-blue-500/30 text-blue-400",
  }[type];

  const iconColor = {
    error: "text-red-400",
    success: "text-emerald-400",
    info: "text-blue-400",
  }[type];

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] flex justify-center pointer-events-none px-4 pb-safe"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 16px)" }}
    >
      <div
        className={cn(
          "pointer-events-auto max-w-md w-full border rounded-2xl px-4 py-3 shadow-2xl backdrop-blur-xl transition-all duration-300 ease-out",
          colorClasses,
          isVisible && !isExiting
            ? "translate-y-0 opacity-100"
            : "translate-y-4 opacity-0"
        )}
      >
        <div className="flex items-start gap-3">
          <div className={cn("mt-0.5", iconColor)}>
            {icon}
          </div>
          <p className="flex-1 text-[13px] sm:text-sm font-medium leading-relaxed text-text-primary">
            {message}
          </p>
          <button
            onClick={handleClose}
            className="shrink-0 p-1 rounded-lg hover:bg-white/10 transition-colors text-text-secondary hover:text-text-primary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
