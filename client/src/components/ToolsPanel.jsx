import React, { useEffect, useMemo, useState } from 'react';
import styled from 'styled-components';
import { Button as UiButton, Input as UiInput, Badge } from './ui';

/**
 * ARC's actual registered tool set (mirrors server/tools registry schemas).
 * Descriptions are the real tool descriptions, shortened for display.
 * No placeholders — every entry maps to a server-side tool plugin.
 */
const TOOL_CATALOG = [
  { name: 'webSearch', category: 'Web & Research', requires: null, example: 'Search the web for the latest AI news',
    about: 'Search the web for real-time information, facts, people, places, or current events.' },
  { name: 'scrapeWebsite', category: 'Web & Research', requires: null, example: 'Summarize this article for me: https://example.com',
    about: 'Fetch and read the text content of a live website or article.' },
  { name: 'openWebsite', category: 'Web & Research', requires: null, example: 'Open youtube.com for me',
    about: 'Open a website or URL in your browser.' },
  { name: 'getTopNews', category: 'Web & Research', requires: null, example: 'What are the top news headlines right now?',
    about: 'Fetch the latest real-time top news headlines from around the world.' },
  { name: 'deepResearchSwarm', category: 'Web & Research', requires: null, example: 'Research the future of solid-state batteries in depth',
    about: 'Deploy a multi-agent swarm to research a topic across websites and write a report.' },
  { name: 'sendEmail', category: 'Communication', requires: null, example: 'Send an email to alex@example.com about the meeting',
    about: 'Send an email to a specified recipient.' },
  { name: 'sendWhatsAppMessage', category: 'Communication', requires: 'whatsapp', example: 'Send a WhatsApp message to Mom saying I will be late',
    about: 'Send a WhatsApp message using your connected WhatsApp session.' },
  { name: 'checkCalendar', category: 'Calendar & Reminders', requires: 'google', example: 'What is on my calendar tomorrow?',
    about: 'Read your Google Calendar and return upcoming events.' },
  { name: 'scheduleMeeting', category: 'Calendar & Reminders', requires: 'google', example: 'Schedule a team sync tomorrow at 10am for 30 minutes',
    about: 'Schedule a new meeting on your Google Calendar.' },
  { name: 'createReminder', category: 'Calendar & Reminders', requires: null, example: 'Remind me to drink water in 30 minutes',
    about: 'Create a reminder or task and save it.' },
  { name: 'setReminder', category: 'Calendar & Reminders', requires: null, example: 'Set a recurring alarm every weekday at 8am',
    about: 'Schedule a proactive background or recurring reminder.' },
  { name: 'stopReminder', category: 'Calendar & Reminders', requires: null, example: 'Stop my active reminders',
    about: 'Stop, clear, or cancel active background reminders and alarms.' },
  { name: 'recallMemory', category: 'Memory', requires: null, example: 'What do you remember about my projects?',
    about: 'Search long-term memory for past knowledge, facts, or documents.' },
  { name: 'memorize', category: 'Memory', requires: null, example: 'Remember that I prefer concise answers',
    about: 'Save important information or documents to long-term memory.' },
  { name: 'storeUserFact', category: 'Memory', requires: null, example: 'Remember that my favorite city is Indore',
    about: 'Store a permanent fact or preference about you.' },
  { name: 'playMedia', category: 'Media', requires: null, example: 'Play some lo-fi music',
    about: 'Play music, songs, videos, or podcasts you request.' },
  { name: 'stopMedia', category: 'Media', requires: null, example: 'Stop the music',
    about: 'Stop currently playing media and close the player.' },
  { name: 'copyToClipboard', category: 'Media', requires: null, example: 'Copy that code to my clipboard',
    about: 'Copy text, code, or content to your system clipboard on request.' },
  { name: 'getTime', category: 'System & Compute', requires: null, example: 'What time is it right now?',
    about: 'Get the current system time and date.' },
  { name: 'getWeather', category: 'System & Compute', requires: null, example: 'What is the weather in Ratlam today?',
    about: 'Get current real-time weather for a location.' },
  { name: 'executeCode', category: 'System & Compute', requires: null, example: 'Calculate 17% of 245000 precisely',
    about: 'Run a small JavaScript snippet in a hardened sandbox for exact answers.' },
  { name: 'changeTheme', category: 'System & Compute', requires: null, example: 'Switch to hacker mode',
    about: 'Change the visual UI theme of the application.' },
];

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1500;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 8vh 16px 16px;
`;

const Panel = styled.div`
  width: min(680px, 100%);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  border: 1px solid var(--border);
  background: linear-gradient(180deg, var(--surface-elevated), var(--surface));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;
`;

const Header = styled.div`
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border-subtle);
`;

const Title = styled.h3`
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground);
`;

const Subtitle = styled.p`
  margin: 6px 0 0;
  color: var(--foreground-subtle);
  font-size: 12.5px;
  line-height: 1.55;
`;

const List = styled.div`
  overflow-y: auto;
  padding: 12px 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 4px;
`;

const CategoryLabel = styled.div`
  padding: 12px 4px 6px;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgba(var(--accent-soft-rgb), 0.5);
  font-weight: 700;
  &:first-child { padding-top: 4px; }
`;

const ToolRow = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid transparent;
  transition: all 0.15s;
  &:hover { background: rgba(255, 255, 255, 0.03); border-color: var(--border-subtle); }
`;

const ToolIcon = styled.span`
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: rgba(var(--primary-rgb), 0.07);
  border: 1px solid rgba(var(--primary-rgb), 0.14);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  flex-shrink: 0;
`;

const ToolMain = styled.div`
  flex: 1;
  min-width: 0;
`;

const ToolName = styled.div`
  font-size: 13px;
  font-weight: 650;
  color: var(--foreground);
  font-family: 'SF Mono', Consolas, monospace;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`;

const ToolAbout = styled.div`
  font-size: 12px;
  color: var(--foreground-muted);
  margin-top: 3px;
  line-height: 1.55;
`;

const CATEGORY_ICONS = {
  'Web & Research': '🌐',
  Communication: '💬',
  'Calendar & Reminders': '📅',
  Memory: '🧠',
  Media: '🎵',
  'System & Compute': '⚙️',
};

const ToolsPanel = ({ isOpen, onClose, onUseExample, googleConnected, whatsappConnected }) => {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? TOOL_CATALOG
      : TOOL_CATALOG.filter(t => t.name.toLowerCase().includes(q) || t.about.toLowerCase().includes(q));
    const groups = {};
    filtered.forEach(t => {
      if (!groups[t.category]) groups[t.category] = [];
      groups[t.category].push(t);
    });
    return groups;
  }, [query]);

  if (!isOpen) return null;

  const requirementState = (tool) => {
    if (tool.requires === 'google') return { label: googleConnected ? 'Calendar linked' : 'Needs Google Calendar', ok: googleConnected };
    if (tool.requires === 'whatsapp') return { label: whatsappConnected ? 'WhatsApp linked' : 'Needs WhatsApp', ok: whatsappConnected };
    return null;
  };

  return (
    <Overlay onClick={onClose} role="dialog" aria-label="Tools">
      <Panel onClick={e => e.stopPropagation()}>
        <Header>
          <Title>Tools</Title>
          <Subtitle>
            {TOOL_CATALOG.length} capabilities ARC can use while chatting. Ask in plain language —
            ARC picks the right tool. "Try it" drops an example into the composer.
          </Subtitle>
        </Header>
        <div style={{ margin: '12px 16px 0' }}>
          <UiInput
            type="search"
            placeholder="Search tools..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search tools"
          />
        </div>
        <List>
          {Object.entries(grouped).map(([cat, tools]) => (
            <div key={cat}>
              <CategoryLabel>{cat}</CategoryLabel>
              {tools.map(t => {
                const req = requirementState(t);
                return (
                  <ToolRow key={t.name}>
                    <ToolIcon>{CATEGORY_ICONS[cat] || '🔧'}</ToolIcon>
                    <ToolMain>
                      <ToolName>
                        {t.name}
                        {req && <Badge tone={req.ok ? 'success' : 'warning'} outline className="text-[10px]">{req.label}</Badge>}
                      </ToolName>
                      <ToolAbout>{t.about}</ToolAbout>
                    </ToolMain>
                    <UiButton variant="outline" size="sm" className="shrink-0 self-start mt-0.5" type="button" onClick={() => { onUseExample?.(t.example); onClose(); }}>
                      Try it
                    </UiButton>
                  </ToolRow>
                );
              })}
            </div>
          ))}
          {Object.keys(grouped).length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--foreground-subtle)', fontSize: 13 }}>
              No tools match "{query}"
            </div>
          )}
        </List>
      </Panel>
    </Overlay>
  );
};

export default ToolsPanel;
