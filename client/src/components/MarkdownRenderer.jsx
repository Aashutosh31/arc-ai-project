import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeHighlight from 'rehype-highlight';
import styled from 'styled-components';
import 'highlight.js/styles/github-dark-dimmed.css';

/**
 * Recursively extract plain text from a React node tree.
 * Used for the Copy button so highlighted <span> trees never
 * leak "[object Object]" or "undefined" into copied/output text.
 */
const extractText = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && 'props' in node) return extractText(node.props.children);
  return '';
};

const normalizeClass = (className) => {
  if (!className) return '';
  return Array.isArray(className) ? className.join(' ') : String(className);
};

/** Supports c++, c#, f#, objective-c, etc. — the old (\w+) truncated them to "c". */
const extractLanguage = (className) => {
  const match = /language-([\w#+.-]+)/.exec(normalizeClass(className));
  return match ? match[1] : '';
};

const MarkdownBody = styled.div`
  font-size: 15px;
  line-height: 1.8;
  color: var(--foreground-muted);
  word-wrap: break-word;
  overflow-wrap: break-word;
  min-width: 0;

  > *:first-child { margin-top: 0; }
  > *:last-child { margin-bottom: 0; }

  p {
    margin: 0 0 0.9em;
    &:last-child { margin-bottom: 0; }
  }

  h1, h2, h3, h4, h5, h6 {
    margin: 1.5em 0 0.6em;
    color: var(--foreground);
    font-weight: 700;
    line-height: 1.35;
    letter-spacing: -0.01em;
    &:first-child { margin-top: 0; }
  }
  h1 { font-size: 1.4em; padding-bottom: 0.3em; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }
  h2 { font-size: 1.22em; padding-bottom: 0.25em; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  h3 { font-size: 1.1em; color: var(--accent-soft); }
  h4 { font-size: 1em; }
  h5, h6 { font-size: 0.92em; color: var(--foreground-subtle); }

  strong { color: var(--foreground); font-weight: 650; }
  em { font-style: italic; }
  del { color: var(--foreground-subtle); }

  a {
    color: var(--accent-soft);
    text-decoration: none;
    border-bottom: 1px solid rgba(var(--accent-soft-rgb), 0.35);
    transition: border-color 0.2s;
    &:hover { border-color: var(--accent-soft); }
  }

  ul, ol {
    margin: 0.6em 0 1em;
    padding-left: 1.6em;
  }
  li {
    margin: 0.35em 0;
    line-height: 1.7;
    padding-left: 0.15em;
  }
  li::marker { color: rgba(var(--accent-soft-rgb), 0.6); }
  li > ul, li > ol {
    margin: 0.3em 0 0.3em;
  }
  ul.contains-task-list, ol.contains-task-list {
    list-style: none;
    padding-left: 0.2em;
  }
  li.task-list-item { padding-left: 0; }

  blockquote {
    margin: 1em 0;
    padding: 0.7em 1.1em;
    border-left: 3px solid rgba(var(--accent-soft-rgb), 0.5);
    background: rgba(var(--accent-soft-rgb), 0.03);
    border-radius: 0 8px 8px 0;
    color: var(--foreground-muted);
    p { margin: 0.35em 0; }
  }

  hr {
    border: none;
    border-top: 1px solid rgba(255, 255, 255, 0.09);
    margin: 1.6em 0;
  }

  table {
    width: max-content;
    min-width: 100%;
    max-width: 100%;
    border-collapse: collapse;
    margin: 0;
    font-size: 13.5px;
    line-height: 1.55;
  }
  thead { background: rgba(var(--accent-soft-rgb), 0.05); }
  th {
    padding: 9px 14px;
    text-align: left;
    font-weight: 650;
    color: var(--violet);
    border-bottom: 1px solid rgba(var(--violet-rgb), 0.25);
    white-space: nowrap;
  }
  td {
    padding: 9px 14px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    color: var(--foreground-muted);
    vertical-align: top;
  }
  tbody tr:hover td { background: rgba(255, 255, 255, 0.02); }
  tbody tr:last-child td { border-bottom: none; }

  code {
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
    font-size: 0.86em;
    background: rgba(var(--accent-soft-rgb), 0.07);
    color: var(--accent-soft);
    padding: 0.15em 0.45em;
    border-radius: 5px;
    border: 1px solid rgba(var(--accent-soft-rgb), 0.1);
    white-space: nowrap;
  }

  /* Intentionally fixed code surface: pairs with the static
     highlight.js theme imported above so syntax colors stay readable. */
  pre {
    margin: 1.1em 0;
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(4, 6, 18, 0.92);
  }

  /* Wide-viewport breakout: code uses spare chat-area width beyond the
     prose column. The formula assumes a 280px sidebar (conservative when
     collapsed) and floors at 0, so it can never overflow or x-scroll. */
  @media (min-width: 1100px) {
    pre {
      --out: max(0px, min(110px, calc((100vw - 280px - 980px - 48px) / 2)));
      margin-left: calc(-1 * var(--out));
      margin-right: calc(-1 * var(--out));
    }
  }

  pre code {
    display: block;
    padding: 14px 16px;
    background: transparent;
    color: var(--foreground-muted);
    font-size: 13px;
    line-height: 1.65;
    overflow-x: auto;
    border: none;
    border-radius: 0;
    white-space: pre;
    tab-size: 2;
  }

  input[type="checkbox"] {
    margin-right: 8px;
    accent-color: var(--primary-hex);
    width: 14px;
    height: 14px;
    vertical-align: -2px;
  }

  img {
    max-width: 100%;
    border-radius: 10px;
    margin: 0.6em 0;
  }
`;

const TableScroll = styled.div`
  overflow-x: auto;
  margin: 1.1em 0;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.015);
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
  &::-webkit-scrollbar { height: 6px; }
  &::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }

  /* Same wide-viewport breakout as code blocks (see MarkdownBody pre). */
  @media (min-width: 1100px) {
    --out: max(0px, min(110px, calc((100vw - 280px - 980px - 48px) / 2)));
    margin-left: calc(-1 * var(--out));
    margin-right: calc(-1 * var(--out));
  }
`;

const CodeHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  background: rgba(255, 255, 255, 0.03);
  border-bottom: 1px solid var(--border-subtle);
  font-size: 11px;
  color: var(--foreground-subtle);
  font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
  letter-spacing: 0.04em;
`;

const CopyButton = styled.button`
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border);
  color: var(--foreground-muted);
  padding: 3px 10px;
  border-radius: 5px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s;
  &:hover { background: rgba(var(--accent-soft-rgb), 0.1); color: var(--accent-soft); border-color: rgba(var(--accent-soft-rgb), 0.25); }
`;

const CollapsibleWrap = styled.div`
  position: relative;
`;

const CollapsibleInner = styled.div`
  max-height: ${({ $expanded }) => ($expanded ? 'none' : '560px')};
  overflow: hidden;
  position: relative;
`;

const FadeMask = styled.div`
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 120px;
  background: linear-gradient(transparent, var(--surface));
  pointer-events: none;
`;

const ExpandToggle = styled.button`
  margin-top: 10px;
  border: 1px solid rgba(var(--accent-soft-rgb), 0.18);
  background: rgba(var(--accent-soft-rgb), 0.05);
  color: var(--accent-soft);
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  &:hover { background: rgba(var(--accent-soft-rgb), 0.1); }
`;

/** Strip react-markdown's internal `node` (hast) prop before spreading onto DOM. */
const withoutNode = (props) => {
  const copy = { ...(props || {}) };
  delete copy.node;
  return copy;
};

/** Inline code only — fenced blocks are assembled in `BlockPre` below. */
const InlineCode = (props) => {
  const { className, children } = props;
  return <code {...withoutNode(props)} className={normalizeClass(className) || undefined}>{children ?? ''}</code>;
};

const CodeBlock = ({ language, copyText, children }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const text = typeof copyText === 'string' ? copyText : extractText(children);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — no-op
    }
  };

  return (
    <pre>
      <CodeHeader>
        <span>{language || 'code'}</span>
        <CopyButton type="button" onClick={handleCopy}>
          {copied ? 'Copied' : 'Copy'}
        </CopyButton>
      </CodeHeader>
      <code className={language ? `language-${language}` : ''}>{children}</code>
    </pre>
  );
};

/** Height-based collapse: structure-agnostic, never slices markdown source. */
const CollapsibleContent = ({ isStreaming, children }) => {
  const [expanded, setExpanded] = useState(false);
  if (isStreaming) return <>{children}</>;
  return (
    <CollapsibleWrap>
      <CollapsibleInner $expanded={expanded}>
        {children}
        {!expanded && <FadeMask />}
      </CollapsibleInner>
      <ExpandToggle type="button" onClick={() => setExpanded(p => !p)} aria-expanded={expanded}>
        {expanded ? 'Show less' : 'Show more'}
      </ExpandToggle>
    </CollapsibleWrap>
  );
};

/**
 * Collapse gate (source chars). The collapse itself is height-based
 * (560px + fade), never a character slice, so markdown structures stay
 * complete. The gate exists only to skip the collapsible wrapper for
 * short/medium answers; genuinely long answers still get Show more/less.
 */
const LONG_RENDER_CHARS = 6000;

const MarkdownRenderer = ({ content, isStreaming = false, collapsibleThreshold = LONG_RENDER_CHARS }) => {
  if (content == null) return null;
  const source = String(content);
  if (!source) return null;

  const body = (
    <MarkdownBody>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
        components={{
          // Block code is assembled here (single <pre>, no nesting).
          // In react-markdown v9+, `pre` receives its `code` child as an
          // unevaluated element whose type is the `InlineCode` override,
          // so detect by component identity (with a 'code' fallback).
          pre(props) {
            const { children } = props;
            const list = Array.isArray(children) ? children : [children];
            const codeEl = list.find(c => c && typeof c === 'object' && (c.type === InlineCode || c.type === 'code')) || null;
            if (!codeEl || !codeEl.props) return <pre>{children}</pre>;
            const language = extractLanguage(codeEl.props.className);
            const kids = codeEl.props.children;
            const copyText = extractText(kids);
            return <CodeBlock language={language} copyText={copyText}>{kids ?? ''}</CodeBlock>;
          },
          code: InlineCode,
          table(props) {
            return (
              <TableScroll>
                <table>{props.children}</table>
              </TableScroll>
            );
          },
          input(props) {
            const { type, checked } = props;
            if (type === 'checkbox') {
              return <input type="checkbox" checked={Boolean(checked)} readOnly disabled />;
            }
            return null;
          },
          a(props) {
            const { href, children } = props;
            const external = typeof href === 'string' && /^https?:\/\//i.test(href);
            return (
              <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
                {children}
              </a>
            );
          },
          img(props) {
            const { alt } = props;
            return <img {...withoutNode(props)} alt={alt || ''} loading="lazy" />;
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </MarkdownBody>
  );

  if (!isStreaming && source.length > collapsibleThreshold) {
    return <CollapsibleContent isStreaming={isStreaming}>{body}</CollapsibleContent>;
  }
  return body;
};

export default MarkdownRenderer;
