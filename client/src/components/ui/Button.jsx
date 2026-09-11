/**
 * Source-owned ARC Button primitive (Tailwind + ARC tokens).
 * Variants consume semantic utilities only — no theme-id logic.
 */
import React from 'react';

const VARIANTS = {
  primary: 'bg-primary text-primary-foreground hover:brightness-110 shadow-md',
  secondary: 'bg-card text-foreground border border-border hover:border-primary/50',
  ghost: 'bg-transparent text-foreground hover:bg-muted',
  destructive: 'bg-destructive text-destructive-foreground hover:brightness-110',
};

const SIZES = {
  sm: 'h-8 px-3 text-xs rounded-[var(--radius-sm)]',
  md: 'h-10 px-4 text-sm rounded-[var(--radius-md)]',
  lg: 'h-12 px-6 text-base rounded-[var(--radius-md)]',
};

export const Button = React.forwardRef(function Button(
  { variant = 'primary', size = 'md', className = '', ...props },
  ref
) {
  return (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center gap-2 font-semibold transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 ${VARIANTS[variant] || VARIANTS.primary} ${SIZES[size] || SIZES.md} ${className}`}
      {...props}
    />
  );
});

export default Button;
