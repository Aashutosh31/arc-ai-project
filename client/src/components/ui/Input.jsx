/**
 * Source-owned ARC form primitives (Tailwind + ARC tokens).
 */
import React from 'react';

const fieldClass =
  'w-full bg-card text-foreground placeholder:text-muted-foreground border border-border rounded-[var(--radius-md)] px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-2 focus:ring-ring/40 disabled:opacity-50';

export const Input = React.forwardRef(function Input({ className = '', ...props }, ref) {
  return <input ref={ref} className={`${fieldClass} h-10 ${className}`} {...props} />;
});

export const Textarea = React.forwardRef(function Textarea({ className = '', ...props }, ref) {
  return <textarea ref={ref} className={`${fieldClass} min-h-20 resize-y ${className}`} {...props} />;
});

export default Input;
