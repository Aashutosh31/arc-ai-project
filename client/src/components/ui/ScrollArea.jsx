/**
 * Source-owned ARC ScrollArea primitive (themed scrollbars).
 */
import React from 'react';

export function ScrollArea({ className = '', ...props }) {
  return (
    <div
      className={`overflow-auto [scrollbar-width:thin] [scrollbar-color:var(--border-strong)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2 [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-track]:bg-transparent ${className}`}
      {...props}
    />
  );
}

export default ScrollArea;
