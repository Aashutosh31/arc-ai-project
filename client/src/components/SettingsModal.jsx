import React, { useEffect, useState } from 'react';
import styled from 'styled-components';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useChat } from '../contexts/ChatContext';
import { THEME_CHANGE_EVENT, applyTheme, getStoredTheme } from '../utils/theme';
import { listThemes } from '../theme/themes';

const SECTIONS = [
  { id: 'account', label: 'Account', icon: '👤' },
  { id: 'appearance', label: 'Appearance', icon: '🎨' },
  { id: 'voice', label: 'Voice', icon: '🎤' },
  { id: 'model', label: 'AI / Model', icon: '🧠' },
  { id: 'memory', label: 'Memory', icon: '💾' },
  { id: 'workspaces', label: 'Workspaces', icon: '📁' },
  { id: 'integrations', label: 'Integrations', icon: '🔗' },
  { id: 'credits', label: 'Credits / Usage', icon: '💳' },
  { id: 'security', label: 'Security', icon: '🔒' },
];

const Overlay = styled.div`
  position: fixed;
  inset: 0;
  z-index: 1600;
  background: rgba(0, 0, 0, 0.62);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
`;

const Modal = styled.div`
  width: min(820px, 100%);
  height: min(600px, calc(100vh - 60px));
  display: flex;
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: linear-gradient(180deg, var(--surface-elevated), var(--surface));
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.6);
  overflow: hidden;

  @media (max-width: 640px) {
    flex-direction: column;
    height: min(640px, calc(100vh - 40px));
  }
`;

const Nav = styled.nav`
  width: 210px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-subtle);
  padding: 14px 10px;
  overflow-y: auto;

  @media (max-width: 640px) {
    width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding: 10px;
  }
`;

const NavItem = styled.button`
  width: 100%;
  text-align: left;
  padding: 9px 12px;
  border-radius: var(--radius-sm);
  border: none;
  background: ${({ $active }) => ($active ? 'rgba(var(--primary-rgb), 0.08)' : 'transparent')};
  color: ${({ $active }) => ($active ? 'var(--foreground)' : 'var(--foreground-muted)')};
  font-size: 13px;
  font-weight: ${({ $active }) => ($active ? '600' : '400')};
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: all 0.15s;
  white-space: nowrap;
  &:hover { background: rgba(255, 255, 255, 0.04); color: var(--foreground); }
`;

const Body = styled.div`
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 22px 24px;
`;

const SectionTitle = styled.h3`
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 700;
  color: var(--foreground);
`;

const SectionDesc = styled.p`
  margin: 0 0 18px;
  font-size: 12.5px;
  color: var(--foreground-subtle);
  line-height: 1.6;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  &:last-child { border-bottom: none; }
`;

const RowLabel = styled.div`
  font-size: 13px;
  color: var(--foreground-muted);
  font-weight: 550;
`;

const RowHint = styled.div`
  font-size: 11.5px;
  color: var(--foreground-subtle);
  margin-top: 3px;
  line-height: 1.5;
`;

const Pill = styled.span`
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 4px 10px;
  border-radius: 999px;
  color: ${({ $tone }) => ($tone === 'ok' ? 'var(--success)' : $tone === 'warn' ? 'var(--warning)' : 'var(--foreground-subtle)')};
  border: 1px solid ${({ $tone }) => ($tone === 'ok' ? 'rgba(var(--success-rgb),0.3)' : $tone === 'warn' ? 'rgba(var(--warning-rgb),0.3)' : 'var(--border)')};
  background: ${({ $tone }) => ($tone === 'ok' ? 'rgba(var(--success-rgb),0.06)' : $tone === 'warn' ? 'rgba(var(--warning-rgb),0.06)' : 'rgba(255,255,255,0.03)')};
  white-space: nowrap;
`;

const ActionButton = styled.button`
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(var(--primary-rgb), 0.25);
  background: rgba(var(--primary-rgb), 0.07);
  color: var(--accent-soft);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  &:hover { background: rgba(var(--primary-rgb), 0.13); }
  &:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const GhostButton = styled(ActionButton)`
  border-color: var(--border);
  background: transparent;
  color: var(--foreground-muted);
  &:hover { background: rgba(255, 255, 255, 0.05); color: var(--foreground); }
`;

const DangerButton = styled(ActionButton)`
  border-color: rgba(255, 70, 70, 0.4);
  background: rgba(255, 70, 70, 0.08);
  color: var(--destructive-soft);
  &:hover { background: rgba(255, 70, 70, 0.15); }
`;

const Toggle = styled.button`
  width: 42px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid ${({ $on }) => ($on ? 'rgba(var(--primary-rgb),0.4)' : 'rgba(255,255,255,0.15)')};
  background: ${({ $on }) => ($on ? 'rgba(var(--primary-rgb),0.25)' : 'rgba(255,255,255,0.06)')};
  cursor: pointer;
  position: relative;
  flex-shrink: 0;
  transition: all 0.2s;
  &::after {
    content: '';
    position: absolute;
    top: 2px;
    left: ${({ $on }) => ($on ? '20px' : '2px')};
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: ${({ $on }) => ($on ? 'var(--primary-hex)' : 'rgba(255,255,255,0.4)')};
    transition: all 0.2s;
  }
`;

const ThemeCard = styled.button`
  width: 100%;
  text-align: left;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid ${({ $active }) => ($active ? 'rgba(var(--primary-rgb),0.35)' : 'rgba(255,255,255,0.08)')};
  background: ${({ $active }) => ($active ? 'rgba(var(--primary-rgb),0.05)' : 'rgba(255,255,255,0.02)')};
  color: var(--foreground);
  cursor: pointer;
  margin-bottom: 8px;
  transition: all 0.15s;
  &:hover { border-color: rgba(var(--primary-rgb), 0.25); }
`;

/* Gallery foundation: swatch row renders straight from registry preview data.
   Implemented with Tailwind utilities (first surface on the new stack). */

const CloseButton = styled.button`
  position: absolute;
  top: 14px;
  right: 14px;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--foreground-muted);
  font-size: 16px;
  cursor: pointer;
  &:hover { color: var(--foreground); background: rgba(255, 255, 255, 0.05); }
`;

const Note = styled.p`
  font-size: 12px;
  color: var(--foreground-subtle);
  line-height: 1.6;
  margin: 12px 0 0;
`;

const ModalShell = styled.div`
  position: relative;
  width: min(820px, 100%);
`;

const SettingsModal = ({
  isOpen, onClose, initialSection = 'account',
  authInfo, providerInfo: providerInfoProp,
  memoryLearningEnabled, onToggleMemoryLearning, onOpenMemory,
  google, whatsapp, onOpenVoice, onSignOut,
}) => {
  const [section, setSection] = useState(initialSection);
  const { workspaces, activeWorkspaceId, switchWorkspace } = useWorkspace();
  const { providerInfo: providerInfoCtx } = useChat();
  const providerInfo = providerInfoProp ?? providerInfoCtx;
  const [theme, setTheme] = useState(() => getStoredTheme());

  useEffect(() => {
    if (isOpen) setSection(initialSection);
  }, [isOpen, initialSection]);

  // Stay in sync when the theme changes elsewhere (e.g. AI changeTheme tool).
  useEffect(() => {
    const sync = (e) => setTheme(e?.detail || getStoredTheme());
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isGuest = authInfo?.authType === 'guest';

  const handleSelectTheme = (id) => {
    setTheme(applyTheme(id));
  };

  return (
    <Overlay onClick={onClose} role="dialog" aria-label="Settings">
      <ModalShell>
        <Modal onClick={e => e.stopPropagation()}>
          <CloseButton onClick={onClose} aria-label="Close settings">×</CloseButton>
          <Nav>
            {SECTIONS.map(s => (
              <NavItem key={s.id} $active={section === s.id} onClick={() => setSection(s.id)}>
                <span>{s.icon}</span> {s.label}
              </NavItem>
            ))}
          </Nav>
          <Body>
            {section === 'account' && (
              <>
                <SectionTitle>Account</SectionTitle>
                <SectionDesc>Who is signed in to ARC-AI on this device.</SectionDesc>
                <Row>
                  <div><RowLabel>{authInfo?.username || (isGuest ? 'Guest' : 'User')}</RowLabel>
                  <RowHint>{isGuest ? 'Guest session' : `${authInfo?.authProvider || 'local'} account`}</RowHint></div>
                  <Pill tone={isGuest ? 'warn' : 'ok'}>{isGuest ? 'Guest' : 'Signed in'}</Pill>
                </Row>
                {isGuest && (
                  <Row>
                    <div><RowLabel>Upgrade to a full account</RowLabel>
                    <RowHint>More credits, Google Calendar, and persistent identity.</RowHint></div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <GhostButton onClick={() => { window.location.href = '/login'; }}>Sign in</GhostButton>
                      <ActionButton onClick={() => { window.location.href = '/register'; }}>Sign up</ActionButton>
                    </div>
                  </Row>
                )}
                {!isGuest && (
                  <Row>
                    <div><RowLabel>Google account</RowLabel>
                    <RowHint>{authInfo?.googleLinked ? 'A Google account is linked.' : 'No Google account linked yet.'}</RowHint></div>
                    <GhostButton onClick={google?.onLinkAccount} disabled={google?.busy}>
                      {authInfo?.googleLinked ? 'Reconnect' : 'Link Google'}
                    </GhostButton>
                  </Row>
                )}
              </>
            )}

            {section === 'appearance' && (
              <>
                <SectionTitle>Appearance</SectionTitle>
                <SectionDesc>ARC-AI visual theme. Applied instantly on this device.</SectionDesc>
                {listThemes().map(t => (
                  <ThemeCard key={t.id} $active={theme === t.id} onClick={() => handleSelectTheme(t.id)} aria-pressed={theme === t.id} aria-label={`${t.name} theme`}>
                    <RowLabel>{t.name}
                      <span aria-hidden="true" className="inline-flex gap-1.5 ml-2 align-middle">
                        {t.preview.map(c => <span key={c} style={{ background: c }} className="inline-block w-3.5 h-3.5 rounded-full border border-white/25" />)}
                      </span>
                    </RowLabel>
                    <RowHint>{t.description}</RowHint>
                  </ThemeCard>
                ))}
              </>
            )}

            {section === 'voice' && (
              <>
                <SectionTitle>Voice</SectionTitle>
                <SectionDesc>Hands-free conversation with automatic silence detection and instant interruption.</SectionDesc>
                <Row>
                  <div><RowLabel>Voice mode</RowLabel>
                  <RowHint>Listening, thinking, speaking states with tap-to-interrupt.</RowHint></div>
                  <ActionButton onClick={() => { onClose(); onOpenVoice?.(); }}>Open voice mode</ActionButton>
                </Row>
                <Note>Voice input and spoken responses use your existing ARC voice pipeline (browser speech + server transcription where available). No additional configuration is required.</Note>
              </>
            )}

            {section === 'model' && (
              <>
                <SectionTitle>AI / Model</SectionTitle>
                <SectionDesc>Which provider answered most recently. ARC routes automatically with fallbacks.</SectionDesc>
                <Row>
                  <div><RowLabel>Current provider</RowLabel>
                  <RowHint>{providerInfo?.detail || 'Selected automatically per request.'}</RowHint></div>
                  <Pill tone={providerInfo?.provider ? 'ok' : 'muted'}>{providerInfo?.provider || 'Auto'}</Pill>
                </Row>
                {providerInfo?.fallbackUsed && (
                  <Row>
                    <div><RowLabel>Fallback</RowLabel>
                    <RowHint>The primary provider was unavailable, so a fallback answered.</RowHint></div>
                    <Pill tone="warn">Fallback used</Pill>
                  </Row>
                )}
                <Note>Manual provider selection is not available yet. Supported backends: Groq, Gemini, Mistral.</Note>
              </>
            )}

            {section === 'memory' && (
              <>
                <SectionTitle>Memory</SectionTitle>
                <SectionDesc>ARC can learn facts and preferences from conversation.</SectionDesc>
                <Row>
                  <div><RowLabel>Memory learning</RowLabel>
                  <RowHint>Automatically remember important details from chats.</RowHint></div>
                  <Toggle $on={memoryLearningEnabled} onClick={onToggleMemoryLearning} aria-label="Toggle memory learning" />
                </Row>
                <Row>
                  <div><RowLabel>Memory manager</RowLabel>
                  <RowHint>Inspect, pin, edit, or delete remembered facts.</RowHint></div>
                  <ActionButton onClick={() => { onClose(); onOpenMemory?.(); }}>Open manager</ActionButton>
                </Row>
              </>
            )}

            {section === 'workspaces' && (
              <>
                <SectionTitle>Workspaces</SectionTitle>
                <SectionDesc>Isolated spaces with their own conversations and memory.</SectionDesc>
                {(workspaces || []).map(w => (
                  <Row key={w._id}>
                    <div><RowLabel>{w.name || 'Workspace'}</RowLabel>
                    {w.description && <RowHint>{w.description}</RowHint>}</div>
                    {String(w._id) === String(activeWorkspaceId)
                      ? <Pill tone="ok">Active</Pill>
                      : <GhostButton onClick={() => switchWorkspace(w._id)}>Switch</GhostButton>}
                  </Row>
                ))}
                <Note>Create, rename, and archive workspaces from the workspace switcher in the sidebar.</Note>
              </>
            )}

            {section === 'integrations' && (
              <>
                <SectionTitle>Integrations</SectionTitle>
                <SectionDesc>Connect ARC to your calendar and messaging.</SectionDesc>
                <Row>
                  <div><RowLabel>Google Calendar</RowLabel>
                  <RowHint>Let ARC read availability and schedule meetings.</RowHint></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Pill tone={google?.connected ? 'ok' : 'muted'}>{google?.connected ? 'Connected' : 'Not connected'}</Pill>
                    <ActionButton onClick={google?.onConnectCalendar} disabled={google?.busy || isGuest}>
                      {isGuest ? 'Sign in first' : google?.connected ? 'Reconnect' : 'Connect'}
                    </ActionButton>
                  </div>
                </Row>
                {google?.note && <Note>{google.note}</Note>}
                <Row>
                  <div><RowLabel>WhatsApp</RowLabel>
                  <RowHint>Send messages on your behalf once connected.</RowHint></div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Pill tone={whatsapp?.connected ? 'ok' : 'muted'}>{whatsapp?.connected ? 'Connected' : 'Not connected'}</Pill>
                    <ActionButton onClick={whatsapp?.onConnect} disabled={isGuest}>
                      {isGuest ? 'Sign in first' : whatsapp?.connected ? 'Reconnect' : 'Connect'}
                    </ActionButton>
                  </div>
                </Row>
              </>
            )}

            {section === 'credits' && (
              <>
                <SectionTitle>Credits / Usage</SectionTitle>
                <SectionDesc>Every ARC response consumes credits from your balance.</SectionDesc>
                <Row>
                  <div><RowLabel>Remaining balance</RowLabel>
                  <RowHint>{isGuest ? 'Guest balances are limited. Sign in for more.' : 'Top up any time from your account page.'}</RowHint></div>
                  <Pill tone="ok">{authInfo?.creditsRemaining ?? '—'} credits</Pill>
                </Row>
              </>
            )}

            {section === 'security' && (
              <>
                <SectionTitle>Security</SectionTitle>
                <SectionDesc>Session and device controls.</SectionDesc>
                <Row>
                  <div><RowLabel>This session</RowLabel>
                  <RowHint>{isGuest ? 'Anonymous guest session on this device.' : `Signed-in ${authInfo?.authProvider || ''} session on this device.`}</RowHint></div>
                  <Pill tone={isGuest ? 'warn' : 'ok'}>{isGuest ? 'Guest' : 'Authenticated'}</Pill>
                </Row>
                <Row>
                  <div><RowLabel>Sign out</RowLabel>
                  <RowHint>Clears the local session and returns to the home page.</RowHint></div>
                  <DangerButton onClick={onSignOut}>Sign out</DangerButton>
                </Row>
              </>
            )}
          </Body>
        </Modal>
      </ModalShell>
    </Overlay>
  );
};

export default SettingsModal;
