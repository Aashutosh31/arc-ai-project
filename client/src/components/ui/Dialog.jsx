/**
 * Source-owned ARC Dialog primitive. Controlled: open + onClose.
 * Escape and overlay-click dismiss; no portals, no external deps.
 */
import React, { useEffect } from 'react';

export function Dialog({ open, onClose, title, className = '', children }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => onClose?.()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-md bg-popover text-foreground border border-border rounded-[var(--radius-lg)] shadow-lg ${className}`}
      >
        {title ? (
          <div className="px-5 pt-4 pb-2 text-base font-semibold">{title}</div>
        ) : null}
        <div className="px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

export default Dialog;
