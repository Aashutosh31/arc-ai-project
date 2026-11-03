import React, { memo, useState } from 'react';
import styled from 'styled-components';

/* Tool-call cards (parity with mobile `ToolCallCard.tsx`).
   The persisted `output` is `{ summarized: true }` today, so cards never
   pretend to have a result — they point at the Executions panel instead.
   Styled with the same CSS variables as the rest of the chat surface. */

const MAX_DETAIL = 4000;

const asRecord = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null;

const inline = (value) => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} item${value.length === 1 ? '' : 's'}]`;
  const json = JSON.stringify(value);
  if (!json) return '—';
  return json.length > 80 ? `${json.slice(0, 77)}…` : json;
};

const pretty = (value) => {
  if (value === null || value === undefined) return '—';
  try {
    const json = JSON.stringify(value, null, 2);
    if (!json) return String(value);
    return json.length > MAX_DETAIL ? `${json.slice(0, MAX_DETAIL)}\n…` : json;
  } catch {
    return String(value);
  }
};

/** Display name for a tool id: `create_calendar_event` → `Create calendar event`. */
const toolTitle = (name) => {
  const cleaned = String(name || 'tool')
    .replace(/[_.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Tool';
};

/** One-line argument preview from the persisted `{ summary }` shape. */
const argumentSummary = (input) => {
  const record = asRecord(input);
  if (record) {
    if (typeof record.summary === 'string' && record.summary.trim()) {
      return record.summary.trim();
    }
    const pairs = Object.entries(record)
      .slice(0, 3)
      .map(([key, value]) => `${key}: ${inline(value)}`);
    if (pairs.length > 0) return pairs.join(' · ');
    return 'No arguments';
  }
  if (typeof input === 'string' && input.trim()) return input.trim();
  return 'No arguments';
};

const hasResult = (output) => {
  if (output === null || output === undefined) return false;
  const record = asRecord(output);
  if (record) {
    if (record.summarized === true) return false;
    return Object.keys(record).length > 0;
  }
  if (Array.isArray(output)) return output.length > 0;
  return String(output).trim().length > 0;
};

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 0 10px;
`;

const Card = styled.div`
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-elevated);
  overflow: hidden;
`;

const Header = styled.button`
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  font: inherit;

  &:hover { background: rgba(255, 255, 255, 0.03); }
  &:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: -2px; }
`;

const IconChip = styled.span`
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  line-height: 1;
  color: ${({ $tone }) => $tone};
  box-shadow: inset 0 0 0 1px ${({ $tone }) => $tone};
`;

const HeaderText = styled.span`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
`;

const ToolName = styled.span`
  font-size: 12.5px;
  font-weight: 600;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const ArgSummary = styled.span`
  font-size: 11.5px;
  color: var(--foreground-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const StatusPill = styled.span`
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  color: ${({ $tone }) => $tone};
  background: rgba(255, 255, 255, 0.04);
`;

const StatusDot = styled.span`
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: ${({ $tone }) => $tone};
`;

const Chevron = styled.span`
  flex: none;
  color: var(--foreground-subtle);
  font-size: 11px;
  line-height: 1;
  transform: rotate(${({ $open }) => ($open ? '180deg' : '0deg')});
  transition: transform 0.15s ease;
`;

const Details = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border);
`;

const DetailLabel = styled.span`
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--foreground-subtle);
`;

const Code = styled.pre`
  margin: 0;
  padding: 8px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.28);
  color: var(--foreground);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre;
  overflow-x: auto;
  max-height: 220px;
  overflow-y: auto;
`;

const ResultHint = styled.span`
  font-size: 11.5px;
  color: var(--foreground-subtle);
  margin-top: 4px;
`;

const ToolCallCard = memo(({ call }) => {
  const [open, setOpen] = useState(false);

  const status = call?.status ?? 'pending';
  const tone =
    status === 'success'
      ? 'var(--success)'
      : status === 'failed'
        ? 'var(--destructive)'
        : 'var(--warning)';
  const statusLabel =
    status === 'success' ? 'Succeeded' : status === 'failed' ? 'Failed' : 'Pending';
  const showResult = hasResult(call?.output);

  return (
    <Card>
      <Header
        type="button"
        aria-expanded={open}
        aria-label={`${toolTitle(call?.toolName)}, ${statusLabel}. ${open ? 'Collapse' : 'Expand'} details`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconChip $tone={tone} aria-hidden="true">⚙</IconChip>
        <HeaderText>
          <ToolName>{toolTitle(call?.toolName)}</ToolName>
          <ArgSummary>{argumentSummary(call?.input)}</ArgSummary>
        </HeaderText>
        <StatusPill $tone={tone}>
          <StatusDot $tone={tone} />
          {statusLabel}
        </StatusPill>
        <Chevron $open={open} aria-hidden="true">▾</Chevron>
      </Header>

      {open && (
        <Details>
          <DetailLabel>Arguments</DetailLabel>
          <Code>{pretty(call?.input)}</Code>
          {showResult ? (
            <>
              <DetailLabel>Result</DetailLabel>
              <Code>{pretty(call?.output)}</Code>
            </>
          ) : (
            <ResultHint>Result recorded in the Executions panel.</ResultHint>
          )}
        </Details>
      )}
    </Card>
  );
});

ToolCallCard.displayName = 'ToolCallCard';

export const ToolCallList = memo(({ calls }) => {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  return (
    <List>
      {calls.map((call, index) => (
        <ToolCallCard key={`${call?.toolName || 'tool'}-${index}`} call={call} />
      ))}
    </List>
  );
});

ToolCallList.displayName = 'ToolCallList';

export default ToolCallList;
