/**
 * Source-owned ARC Dropdown primitive. Click-outside via dismiss backdrop.
 */
import React, { useEffect, useState } from 'react';

export function Dropdown({ label, className = '', children }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open ]);
  return (
    <div className={`relative inline-block ${className}`}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 h-10 px-4 text-sm font-semibold bg-card text-foreground border border-border rounded-[var(--radius-md)] hover:border-primary/50 transition-all"
      >
        {label}
      </button>
      {open ? (
        <>
          <button
            aria-label="Close menu"
            className="fixed inset-0 z-40 cursor-default bg-transparent border-0 p-0"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute z-50 mt-2 min-w-44 bg-popover text-foreground border border-border rounded-[var(--radius-md)] shadow-lg p-1"
          >
            {React.Children.map(children, (child) =>
              React.isValidElement(child)
                ? React.cloneElement(child, {
                    onClick: (...a) => {
                      child.props.onClick?.(...a);
                      setOpen(false);
                    },
                  })
                : child
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function DropdownItem({ className = '', ...props }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`flex w-full items-center gap-2 px-3 py-2 text-sm text-left text-foreground rounded-[var(--radius-sm)] hover:bg-muted cursor-pointer ${className}`}
      {...props}
    />
  );
}

export default Dropdown;
