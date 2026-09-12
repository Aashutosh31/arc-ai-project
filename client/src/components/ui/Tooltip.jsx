/**
 * Source-owned ARC Tooltip primitive (CSS-only, group-hover).
 */
import React from 'react';

export function Tooltip({ label, side = 'top', className = '', children }) {
  const vertical = side === 'left' || side === 'right';
  const pos =
    side === 'bottom'
      ? 'top-full mt-2 left-1/2 -translate-x-1/2'
      : vertical
        ? side === 'left'
          ? 'right-full mr-2 top-1/2 -translate-y-1/2'
          : 'left-full ml-2 top-1/2 -translate-y-1/2'
        : 'bottom-full mb-2 left-1/2 -translate-x-1/2';
  return (
    <span className={`relative inline-flex group ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute ${pos} whitespace-nowrap px-2 py-1 text-xs bg-popover text-foreground border border-border rounded-[var(--radius-sm)] shadow-md opacity-0 group-hover:opacity-100 transition-opacity z-50`}
      >
        {label}
      </span>
    </span>
  );
}

export default Tooltip;
