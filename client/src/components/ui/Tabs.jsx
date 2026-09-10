/**
 * Source-owned ARC Tabs primitive (controlled).
 */
import React from 'react';

export function Tabs({ value, onChange, className = '', children }) {
  return (
    <div className={className}>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) && child.type === Tab
          ? React.cloneElement(child, {
              $active: child.props.value === value,
              onSelect: () => onChange?.(child.props.value),
            })
          : child
      )}
    </div>
  );
}

export function TabsList({ className = '', ...props }) {
  return (
    <div
      role="tablist"
      className={`inline-flex gap-1 p-1 bg-muted rounded-[var(--radius-md)] ${className}`}
      {...props}
    />
  );
}

export function Tab(props) {
  const { $active, onSelect, className = '', ...rest } = props;
  const domProps = { ...rest };
  delete domProps.value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={!!$active}
      onClick={onSelect}
      className={`px-3 h-8 text-sm font-semibold rounded-[var(--radius-sm)] transition-all cursor-pointer ${
        $active ? 'bg-card text-foreground shadow' : 'text-muted-foreground hover:text-foreground'
      } ${className}`}
      {...domProps}
    />
  );
}

export default Tabs;
