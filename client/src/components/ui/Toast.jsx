/**
 * Source-owned ARC Toast primitive: provider + useToast().
 * Toasts auto-dismiss; viewport is a fixed themed stack.
 */
import React, { useCallback, useRef, useState } from 'react';
import { ToastContext } from './toastContext.js';
let toastSeq = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message, tone = 'default', duration = 4000) => {
      const id = ++toastSeq;
      setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
      timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ toast, dismiss }}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <Toast key={t.id} tone={t.tone} onClose={() => dismiss(t.id)}>
            {t.message}
          </Toast>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const TOAST_TONES = {
  default: 'border-border',
  success: 'border-success',
  warning: 'border-warning',
  destructive: 'border-destructive',
};

export function Toast({ tone = 'default', onClose, className = '', children, ...props }) {
  return (
    <div
      role="status"
      className={`bg-popover text-foreground border ${TOAST_TONES[tone] || TOAST_TONES.default} border-solid rounded-[var(--radius-md)] shadow-lg px-4 py-3 text-sm flex items-start gap-3 ${className}`}
      {...props}
    >
      <span className="flex-1">{children}</span>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss notification"
          className="text-muted-foreground hover:text-foreground cursor-pointer"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

export default Toast;
