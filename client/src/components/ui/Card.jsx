/**
 * Source-owned ARC surface primitives: Card family, Badge, Separator.
 */
import React from 'react';

export function Card({ className = '', ...props }) {
  return (
    <div
      className={`bg-card text-foreground border border-border rounded-[var(--radius-lg)] shadow-md ${className}`}
      {...props}
    />
  );
}

export function CardHeader({ className = '', ...props }) {
  return <div className={`px-5 pt-4 pb-2 ${className}`} {...props} />;
}

export function CardTitle({ className = '', ...props }) {
  return <h3 className={`text-base font-semibold text-foreground ${className}`} {...props} />;
}

export function CardContent({ className = '', ...props }) {
  return <div className={`px-5 pb-5 text-sm text-muted-foreground ${className}`} {...props} />;
}

const BADGE_TONES = {
  default: 'bg-muted text-foreground',
  primary: 'bg-primary text-primary-foreground',
  success: 'bg-success text-success-foreground',
  warning: 'bg-warning text-warning-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
};

const BADGE_OUTLINE_TEXT = {
  default: 'text-foreground',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

const BADGE_OUTLINE_BORDER = {
  default: 'border-border',
  primary: 'border-primary',
  success: 'border-success',
  warning: 'border-warning',
  destructive: 'border-destructive',
};

export function Badge({ tone = 'default', outline = false, className = '', ...props }) {
  const toneClasses = outline
    ? `bg-transparent border ${BADGE_OUTLINE_BORDER[tone] || BADGE_OUTLINE_BORDER.default} ${BADGE_OUTLINE_TEXT[tone] || BADGE_OUTLINE_TEXT.default}`
    : (BADGE_TONES[tone] || BADGE_TONES.default);
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full ${toneClasses} ${className}`}
      {...props}
    />
  );
}

export function Separator({ className = '', ...props }) {
  return <div role="separator" className={`h-px w-full bg-border ${className}`} {...props} />;
}

export default Card;
