import React, { useEffect, useRef } from 'react';
import styled from 'styled-components';

const Wrapper = styled.div`
  position: relative;
`;

const AvatarButton = styled.button`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: ${({ $guest }) => ($guest
    ? 'rgba(255, 207, 112, 0.12)'
    : 'linear-gradient(135deg, rgba(var(--primary-rgb),0.25), rgba(184,135,255,0.25))')};
  color: ${({ $guest }) => ($guest ? 'var(--warning)' : 'var(--foreground)')};
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  &:hover { border-color: var(--border); }
`;

const Menu = styled.div`
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  width: 264px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(255, 255, 255, 0.09);
  background: var(--surface-overlay);
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  z-index: 500;
`;

const Identity = styled.div`
  padding: 14px 16px;
  border-bottom: 1px solid var(--border-subtle);
`;

const Name = styled.div`
  font-size: 13.5px;
  font-weight: 650;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Sub = styled.div`
  font-size: 11.5px;
  color: var(--foreground-subtle);
  margin-top: 3px;
`;

const SessionBadge = styled.span`
  display: inline-block;
  margin-top: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  padding: 3px 9px;
  border-radius: 999px;
  color: ${({ $guest }) => ($guest ? 'var(--warning)' : 'var(--success)')};
  border: 1px solid ${({ $guest }) => ($guest ? 'rgba(255,207,112,0.3)' : 'rgba(77,255,176,0.3)')};
  background: ${({ $guest }) => ($guest ? 'rgba(255,207,112,0.06)' : 'rgba(77,255,176,0.06)')};
`;

const MenuRow = styled.div`
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
  color: var(--foreground-muted);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
`;

const MenuValue = styled.span`
  color: var(--accent-soft);
  font-weight: 600;
`;

const MenuButton = styled.button`
  width: 100%;
  text-align: left;
  padding: 10px 16px;
  border: none;
  background: transparent;
  color: var(--foreground-muted);
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 10px;
  transition: background 0.15s;
  &:hover { background: rgba(255, 255, 255, 0.04); }
`;

const DangerButton = styled(MenuButton)`
  color: var(--destructive-soft);
`;

const GuestNote = styled.div`
  padding: 10px 16px;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--foreground-subtle);
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  a { color: var(--accent-soft); }
`;

const AccountMenu = ({ authInfo, googleConnected, whatsappConnected, onOpenSettings, onSignOut }) => {
  const [open, setOpen] = React.useState(false);
  const ref = useRef(null);
  const isGuest = authInfo?.authType === 'guest';
  const initial = String(authInfo?.username || (isGuest ? 'G' : 'A')).charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open ]);

  const go = (section) => { setOpen(false); onOpenSettings?.(section); };

  return (
    <Wrapper ref={ref}>
      <AvatarButton
        type="button"
        $guest={isGuest}
        onClick={() => setOpen(o => !o)}
        aria-label="Account menu"
        aria-expanded={open}
        title={authInfo?.username || 'Account'}
      >
        {initial}
      </AvatarButton>
      {open && (
        <Menu role="menu">
          <Identity>
            <Name>{authInfo?.username || (isGuest ? 'Guest' : 'User')}</Name>
            <Sub>
              {isGuest ? 'Guest session' : `${authInfo?.authProvider || 'local'} account`}
            </Sub>
            <SessionBadge $guest={isGuest}>{isGuest ? 'Guest' : 'Signed in'}</SessionBadge>
          </Identity>

          {isGuest && (
            <GuestNote>
              Guest mode is limited. <a href="/register">Sign up</a> or <a href="/login">sign in</a> for
              more credits and Google Calendar access.
            </GuestNote>
          )}

          <MenuRow>
            <span>Credits</span>
            <MenuValue>{authInfo?.creditsRemaining ?? '—'}</MenuValue>
          </MenuRow>
          <MenuRow>
            <span>Google Calendar</span>
            <MenuValue>{googleConnected ? 'Linked' : 'Not linked'}</MenuValue>
          </MenuRow>
          <MenuRow>
            <span>WhatsApp</span>
            <MenuValue>{whatsappConnected ? 'Connected' : 'Not connected'}</MenuValue>
          </MenuRow>

          <MenuButton type="button" onClick={() => go('account')}>👤 Account settings</MenuButton>
          <MenuButton type="button" onClick={() => go('integrations')}>🔗 Integrations</MenuButton>
          <MenuButton type="button" onClick={() => go('general')}>⚙️ All settings</MenuButton>
          <DangerButton type="button" onClick={onSignOut}>⏻ Sign out</DangerButton>
        </Menu>
      )}
    </Wrapper>
  );
};

export default AccountMenu;
