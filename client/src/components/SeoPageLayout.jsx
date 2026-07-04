import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import styled, { createGlobalStyle, keyframes } from 'styled-components';
import { LINKS } from '../constants/seoLinks';


const NAV_LINKS = [
  { to: '/features', label: 'Features' },
  { to: '/architecture', label: 'Architecture' },
  { to: '/features/rag-memory', label: 'Memory' },
  { to: '/features/web-research', label: 'Research' },
  { to: '/features/automation', label: 'Automation' },
  { to: '/about', label: 'About' },
];

/* ----------------------------------------------------------------------- */
/* Motion                                                                   */
/* ----------------------------------------------------------------------- */

const drift = keyframes`
  0%   { transform: translate3d(0, 0, 0) scale(1); }
  50%  { transform: translate3d(2%, -3%, 0) scale(1.06); }
  100% { transform: translate3d(0, 0, 0) scale(1); }
`;

const pulse = keyframes`
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(38, 255, 138, 0.5); }
  50% { opacity: 0.6; box-shadow: 0 0 0 5px rgba(38, 255, 138, 0); }
`;

const blink = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; }
`;

/* ----------------------------------------------------------------------- */
/* Global reset for this shell (scoped via the wrapper, but html/body need  */
/* the base color so unrendered edges never flash white)                   */
/* ----------------------------------------------------------------------- */

const GlobalSeoStyle = createGlobalStyle`
  html {
    overflow-x: hidden;
  }
  body {
    background: #050511;
    overflow-x: hidden;
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.001ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.001ms !important;
      scroll-behavior: auto !important;
    }
  }
`;

/* ----------------------------------------------------------------------- */
/* Page shell + ambient background                                         */
/* ----------------------------------------------------------------------- */

const Page = styled.div`
  position: relative;
  min-height: 100dvh;
  width: 100%;
  background: radial-gradient(circle at top, #1a1a3a 0%, #050511 55%, #020208 100%);
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  overflow-x: hidden;

  *:focus-visible {
    outline: 2px solid #00ffff;
    outline-offset: 3px;
    border-radius: 4px;
  }
`;

const Mono = styled.span`
  font-family: ui-monospace, SFMono-Regular, 'Fira Code', Menlo, Consolas, monospace;
`;

const Field = styled.div`
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  overflow: hidden;

  &::before {
    content: '';
    position: absolute;
    inset: -10%;
    background-image:
      linear-gradient(rgba(0, 255, 255, 0.05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 255, 255, 0.05) 1px, transparent 1px);
    background-size: 64px 64px;
    mask-image: radial-gradient(ellipse 70% 60% at 50% 0%, #000 0%, transparent 75%);
  }
`;

const Glow = styled.div`
  position: absolute;
  width: 520px;
  height: 520px;
  border-radius: 50%;
  filter: blur(110px);
  opacity: 0.35;
  animation: ${drift} 22s ease-in-out infinite;

  &.cyan { background: #00ffff; top: -120px; left: -100px; }
  &.violet { background: #8a2be2; top: 30%; right: -160px; animation-delay: -7s; }
  &.magenta { background: #ff00ff; bottom: -160px; left: 30%; animation-delay: -14s; opacity: 0.18; }

  @media (max-width: 700px) {
    width: 280px;
    height: 280px;
    filter: blur(70px);
  }
`;

/* ----------------------------------------------------------------------- */
/* Navigation                                                               */
/* ----------------------------------------------------------------------- */

const HeaderWrap = styled.div`
  position: sticky;
  top: 0;
  z-index: 40;
  width: 100%;
  background: rgba(5, 5, 17, 0.75);
  backdrop-filter: blur(16px) saturate(160%);
  -webkit-backdrop-filter: blur(16px) saturate(160%);
  border-bottom: 1px solid rgba(0, 255, 255, 0.12);
`;

const Nav = styled.header`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 32px;
  max-width: 1280px;
  margin: 0 auto;

  @media (max-width: 900px) {
    padding: 12px 16px;
    gap: 8px;
  }
`;

const Logo = styled(Link)`
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: #fff;
  font-weight: 700;
  font-size: 18px;
  letter-spacing: 0.04em;
  flex-shrink: 0;
  white-space: nowrap;

  span.mark {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #26ff8a;
    box-shadow: 0 0 10px rgba(38, 255, 138, 0.8);
    animation: ${pulse} 2.4s ease-in-out infinite;
    flex-shrink: 0;
  }

  span.text {
    background: linear-gradient(135deg, #00ffff 0%, #8a2be2 60%, #ff00ff 100%);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  @media (max-width: 380px) {
    font-size: 15px;
  }
`;

const NavLinks = styled.nav`
  display: flex;
  align-items: center;
  gap: 4px;

  @media (max-width: 900px) {
    display: none;
  }
`;

const NavItem = styled(Link)`
  position: relative;
  padding: 8px 14px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-decoration: none;
  white-space: nowrap;
  color: ${({ $active }) => ($active ? '#00ffff' : 'rgba(255,255,255,0.65)')};
  background: ${({ $active }) => ($active ? 'rgba(0, 255, 255, 0.08)' : 'transparent')};
  transition: color 0.2s ease, background 0.2s ease;

  &:hover {
    color: #00ffff;
    background: rgba(0, 255, 255, 0.06);
  }
`;

const NavActions = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;

  @media (max-width: 900px) {
    gap: 8px;
  }
`;

/* Hidden below the nav-link breakpoint — these two move into MobileMenu
   instead, so the top bar never has to fit four buttons on a phone. */
const DesktopOnlyActions = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;

  @media (max-width: 900px) {
    display: none;
  }
`;

const GhostLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.85);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  transition: all 0.2s ease;

  &:hover {
    border-color: rgba(0, 255, 255, 0.5);
    color: #00ffff;
  }

  @media (max-width: 560px) {
    span.label { display: none; }
    padding: 9px 10px;
  }
`;

const SolidLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 16px;
  border-radius: 9px;
  background: linear-gradient(135deg, #00ffff, #8a2be2);
  color: #04040f;
  font-size: 13px;
  font-weight: 700;
  text-decoration: none;
  white-space: nowrap;
  box-shadow: 0 0 18px rgba(0, 255, 255, 0.25);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  flex-shrink: 0;

  &:hover {
    transform: translateY(-1px);
    box-shadow: 0 0 26px rgba(0, 255, 255, 0.4);
  }

  @media (max-width: 360px) {
    padding: 9px 12px;
    font-size: 12.5px;
  }
`;

const MenuButton = styled.button`
  display: none;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 9px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.04);
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;

  @media (max-width: 900px) {
    display: inline-flex;
  }
`;

const MobileMenu = styled.div`
  display: ${({ $open }) => ($open ? 'flex' : 'none')};
  flex-direction: column;
  gap: 2px;
  padding: 10px 16px 18px;
  border-top: 1px solid rgba(0, 255, 255, 0.1);

  a {
    padding: 12px 10px;
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.8);
    text-decoration: none;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  a.active { color: #00ffff; background: rgba(0, 255, 255, 0.06); }
`;

const MobileMenuDivider = styled.div`
  height: 1px;
  margin: 8px 10px;
  background: rgba(255, 255, 255, 0.08);
`;

const MobileMenuActions = styled.div`
  display: flex;
  gap: 8px;
  padding: 4px 10px 0;

  a {
    flex: 1;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 9px;
  }
`;

/* ----------------------------------------------------------------------- */
/* Hero                                                                     */
/* ----------------------------------------------------------------------- */

const HeroWrap = styled.section`
  position: relative;
  z-index: 1;
  max-width: 980px;
  margin: 0 auto;
  padding: 90px 32px 50px;
  text-align: center;

  @media (max-width: 600px) {
    padding: 48px 18px 32px;
  }
`;

const EyebrowPill = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border-radius: 999px;
  border: 1px solid rgba(0, 255, 255, 0.3);
  background: rgba(0, 255, 255, 0.05);
  color: #7df7ff;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  margin-bottom: 22px;
  max-width: 100%;

  &::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #00ffff;
    box-shadow: 0 0 8px rgba(0, 255, 255, 0.9);
    flex-shrink: 0;
  }
`;

const Cursor = styled.span`
  display: inline-block;
  width: 6px;
  margin-left: 1px;
  animation: ${blink} 1.1s steps(1) infinite;
  &::after { content: '_'; }
`;

const HeroTitle = styled.h1`
  font-size: 46px;
  line-height: 1.12;
  font-weight: 800;
  letter-spacing: -0.01em;
  margin: 0 0 18px;
  background: linear-gradient(135deg, #ffffff 0%, #c9f9ff 35%, #b887ff 75%, #ff9bf0 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;

  @media (max-width: 720px) {
    font-size: 30px;
  }

  @media (max-width: 380px) {
    font-size: 25px;
  }
`;

const HeroLead = styled.p`
  font-size: 17px;
  line-height: 1.7;
  color: rgba(255, 255, 255, 0.68);
  max-width: 680px;
  margin: 0 auto;

  @media (max-width: 600px) {
    font-size: 15px;
  }
`;

const StatRow = styled.div`
  display: grid;
  grid-template-columns: repeat(${({ $count }) => $count || 3}, minmax(0, 1fr));
  gap: 14px;
  max-width: 760px;
  margin: 38px auto 0;

  @media (max-width: 720px) {
    grid-template-columns: 1fr;
  }
`;

const StatCard = styled.div`
  padding: 18px 16px;
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(0, 255, 255, 0.14);
  text-align: left;
`;

const StatValue = styled.div`
  font-family: ui-monospace, SFMono-Regular, 'Fira Code', Menlo, Consolas, monospace;
  font-size: 15px;
  font-weight: 700;
  color: #00ffff;
  margin-bottom: 6px;
  letter-spacing: 0.01em;
`;

const StatLabel = styled.div`
  font-size: 13px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.55);
`;

/* ----------------------------------------------------------------------- */
/* Body sections (exported for pages to compose with)                      */
/* ----------------------------------------------------------------------- */

const SectionEl = styled.section`
  position: relative;
  z-index: 1;
  max-width: 980px;
  margin: 0 auto;
  padding: 46px 32px;
  opacity: ${({ $visible }) => ($visible ? 1 : 0)};
  transform: translateY(${({ $visible }) => ($visible ? '0' : '18px')});
  transition: opacity 0.6s ease, transform 0.6s ease;

  @media (max-width: 600px) {
    padding: 32px 18px;
  }
`;

export const Section = ({ children, ...rest }) => {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
          }
        });
      },
      { threshold: 0.15 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <SectionEl ref={ref} $visible={visible} {...rest}>
      {children}
    </SectionEl>
  );
};

export const SectionTag = styled.div`
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, 'Fira Code', Menlo, Consolas, monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: #b887ff;
  margin-bottom: 10px;
`;

export const SectionHeading = styled.h2`
  font-size: 26px;
  font-weight: 750;
  letter-spacing: -0.01em;
  margin: 0 0 14px;
  color: #fff;

  @media (max-width: 600px) {
    font-size: 21px;
  }
`;

export const SectionText = styled.p`
  font-size: 15.5px;
  line-height: 1.75;
  color: rgba(255, 255, 255, 0.66);
  max-width: 720px;
  margin: 0 0 18px;

  @media (max-width: 600px) {
    font-size: 14.5px;
  }
`;

export const BulletList = styled.ul`
  list-style: none;
  margin: 18px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 640px;

  li {
    position: relative;
    padding-left: 26px;
    font-size: 14.5px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.72);
  }

  li::before {
    content: '';
    position: absolute;
    left: 0;
    top: 7px;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: linear-gradient(135deg, #00ffff, #8a2be2);
    box-shadow: 0 0 8px rgba(0, 255, 255, 0.5);
    transform: rotate(45deg);
  }
`;

export const CardGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(${({ $min }) => $min || '230px'}, 100%), 1fr));
  gap: 16px;
  margin-top: 22px;
`;

export const Card = styled.div`
  position: relative;
  padding: 22px;
  border-radius: 16px;
  background: linear-gradient(160deg, rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.015));
  border: 1px solid rgba(255, 255, 255, 0.09);
  transition: border-color 0.25s ease, transform 0.25s ease, box-shadow 0.25s ease;

  &:hover {
    border-color: rgba(0, 255, 255, 0.35);
    transform: translateY(-3px);
    box-shadow: 0 14px 34px rgba(0, 0, 0, 0.35), 0 0 24px rgba(0, 255, 255, 0.08);
  }
`;

export const CardTitle = styled.h3`
  font-size: 16px;
  font-weight: 700;
  color: #b887ff;
  margin: 0 0 8px;
`;

export const CardText = styled.p`
  font-size: 14px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.62);
  margin: 0;
`;

export const TechRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
`;

export const TechChip = styled.span`
  font-family: ui-monospace, SFMono-Regular, 'Fira Code', Menlo, Consolas, monospace;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 6px 10px;
  border-radius: 7px;
  color: #7df7ff;
  background: rgba(0, 255, 255, 0.06);
  border: 1px solid rgba(0, 255, 255, 0.18);
`;

export const Divider = styled.div`
  height: 1px;
  max-width: 980px;
  margin: 0 auto;
  background: linear-gradient(90deg, transparent, rgba(0, 255, 255, 0.18), transparent);
`;

/* ----------------------------------------------------------------------- */
/* CTA band                                                                 */
/* ----------------------------------------------------------------------- */

const CtaWrap = styled.section`
  position: relative;
  z-index: 1;
  max-width: 880px;
  margin: 30px auto 80px;
  padding: 42px 36px;
  border-radius: 22px;
  text-align: center;
  background: rgba(10, 10, 26, 0.7);
  border: 1px solid rgba(0, 255, 255, 0.22);
  box-shadow: 0 0 60px rgba(0, 255, 255, 0.08), inset 0 0 30px rgba(138, 43, 226, 0.06);

  @media (max-width: 600px) {
    margin: 20px 14px 56px;
    padding: 28px 18px;
  }
`;

const CtaTitle = styled.h2`
  font-size: 24px;
  font-weight: 750;
  margin: 0 0 10px;
  background: linear-gradient(135deg, #00ffff, #b887ff);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;

  @media (max-width: 600px) {
    font-size: 20px;
  }
`;

const CtaText = styled.p`
  font-size: 15px;
  line-height: 1.65;
  color: rgba(255, 255, 255, 0.62);
  max-width: 540px;
  margin: 0 auto 26px;
`;

const CtaButtons = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex-wrap: wrap;
`;

/* ----------------------------------------------------------------------- */
/* Footer                                                                   */
/* ----------------------------------------------------------------------- */

const FooterEl = styled.footer`
  position: relative;
  z-index: 1;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding: 48px 32px 28px;

  @media (max-width: 600px) {
    padding: 32px 18px 22px;
  }
`;

const FooterInner = styled.div`
  max-width: 1080px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 32px;

  @media (max-width: 760px) {
    grid-template-columns: 1fr;
    gap: 28px;
  }
`;

const FooterBrand = styled.div`
  h3 {
    font-size: 17px;
    margin: 0 0 8px;
    background: linear-gradient(135deg, #00ffff, #8a2be2, #ff00ff);
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  p {
    font-size: 13.5px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.5);
    max-width: 320px;
    margin: 0;
  }
`;

const FooterCol = styled.div`
  h4 {
    font-size: 11px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.4);
    margin: 0 0 14px;
    font-weight: 700;
  }
  display: flex;
  flex-direction: column;
  gap: 10px;

  a {
    font-size: 13.5px;
    color: rgba(255, 255, 255, 0.65);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
  }
  a:hover { color: #00ffff; }
`;

const FooterBottom = styled.div`
  max-width: 1080px;
  margin: 36px auto 0;
  padding-top: 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.4);

  a { color: rgba(255, 255, 255, 0.55); text-decoration: none; }
  a:hover { color: #00ffff; }
`;

/* ----------------------------------------------------------------------- */
/* Tiny inline icons (no extra dependency)                                 */
/* ----------------------------------------------------------------------- */

const IconBase = (props) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props} />
);

export const GithubIcon = (p) => (
  <IconBase {...p}>
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.4c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.9 5.4 3.2 5.4 3.2a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.6c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.1-.5 2V21" />
  </IconBase>
);

export const LinkedinIcon = (p) => (
  <IconBase {...p}>
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <line x1="7.5" y1="10" x2="7.5" y2="17" />
    <circle cx="7.5" cy="6.8" r="0.9" fill="currentColor" stroke="none" />
    <path d="M11.5 17v-4.2c0-1.6 1-2.6 2.4-2.6s2.2 1 2.2 2.6V17" />
  </IconBase>
);

export const XIcon = (p) => (
  <IconBase {...p}>
    <path d="M4 4l16 16M20 4 4 20" />
  </IconBase>
);

export const YoutubeIcon = (p) => (
  <IconBase {...p}>
    <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
    <path d="M10.5 9.5l5 2.5-5 2.5z" fill="currentColor" stroke="none" />
  </IconBase>
);

export const ArrowIcon = (p) => (
  <IconBase width="14" height="14" {...p}>
    <path d="M7 17 17 7M9 7h8v8" />
  </IconBase>
);

const GridIcon = (p) => (
  <IconBase width="14" height="14" {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </IconBase>
);

/* ----------------------------------------------------------------------- */
/* Document head — no extra dependency, just direct DOM updates            */
/* ----------------------------------------------------------------------- */

const useDocumentHead = (title, description) => {
  useEffect(() => {
    if (title) document.title = title;
    if (description) {
      let tag = document.querySelector('meta[name="description"]');
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', 'description');
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', description);
    }
  }, [title, description]);
};

/* ----------------------------------------------------------------------- */
/* Layout                                                                   */
/* ----------------------------------------------------------------------- */

const SeoPageLayout = ({
  title,
  description,
  eyebrow,
  heroTitle,
  heroLead,
  stats,
  ctaTitle,
  ctaText,
  ctaPrimaryLabel = 'Try ARC-AI live',
  ctaPrimaryHref = LINKS.live,
  ctaSecondaryLabel = 'View source on GitHub',
  ctaSecondaryHref = LINKS.repo,
  children,
}) => {
  useDocumentHead(title, description);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Close the mobile menu whenever the route changes, so it never stays
  // open and overlapping content after a navigation.
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  return (
    <Page>
      <GlobalSeoStyle />
      <Field>
        <Glow className="cyan" />
        <Glow className="violet" />
        <Glow className="magenta" />
      </Field>

      <HeaderWrap>
        <Nav>
          <Logo to="/">
            <span className="mark" aria-hidden="true" />
            <span className="text">ARC·AI</span>
          </Logo>

          <NavLinks>
            {NAV_LINKS.map((item) => (
              <NavItem key={item.to} to={item.to} $active={location.pathname === item.to}>
                {item.label}
              </NavItem>
            ))}
          </NavLinks>

          <NavActions>
            <DesktopOnlyActions>
              <GhostLink href={LINKS.repo} target="_blank" rel="noopener noreferrer">
                <GithubIcon />
                <span className="label">GitHub</span>
              </GhostLink>
              <SolidLink href={LINKS.live} target="_blank" rel="noopener noreferrer">
                Dashboard <ArrowIcon />
              </SolidLink>
            </DesktopOnlyActions>

            <SolidLink href={LINKS.signup} target="_blank" rel="noopener noreferrer">
              Register
            </SolidLink>

            <MenuButton onClick={() => setMenuOpen((open) => !open)} aria-label="Toggle navigation" aria-expanded={menuOpen}>
              {menuOpen ? <XIcon width="16" height="16" /> : <GridIcon />}
            </MenuButton>
          </NavActions>
        </Nav>

        <MobileMenu $open={menuOpen}>
          {NAV_LINKS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={location.pathname === item.to ? 'active' : ''}
              onClick={() => setMenuOpen(false)}
            >
              {item.label}
            </Link>
          ))}

          <MobileMenuDivider />

          <MobileMenuActions>
            <SolidLink href={LINKS.live} target="_blank" rel="noopener noreferrer">
              Dashboard
            </SolidLink>
            <GhostLink href={LINKS.repo} target="_blank" rel="noopener noreferrer">
              <GithubIcon /> <span className="label">GitHub</span>
            </GhostLink>
          </MobileMenuActions>
        </MobileMenu>
      </HeaderWrap>

      <HeroWrap>
        {eyebrow && (
          <EyebrowPill>
            <Mono>{eyebrow}</Mono>
            <Cursor aria-hidden="true" />
          </EyebrowPill>
        )}
        <HeroTitle>{heroTitle}</HeroTitle>
        <HeroLead>{heroLead}</HeroLead>
        {Array.isArray(stats) && stats.length > 0 && (
          <StatRow $count={stats.length}>
            {stats.map((stat) => (
              <StatCard key={stat.value}>
                <StatValue>{stat.value}</StatValue>
                <StatLabel>{stat.label}</StatLabel>
              </StatCard>
            ))}
          </StatRow>
        )}
      </HeroWrap>

      {children}

      {(ctaTitle || ctaText) && (
        <CtaWrap>
          {ctaTitle && <CtaTitle>{ctaTitle}</CtaTitle>}
          {ctaText && <CtaText>{ctaText}</CtaText>}
          <CtaButtons>
            <SolidLink href={ctaPrimaryHref} target="_blank" rel="noopener noreferrer">
              {ctaPrimaryLabel} <ArrowIcon />
            </SolidLink>
            <SolidLink href={ctaSecondaryHref} target="_blank" rel="noopener noreferrer">
              <span className="label">{ctaSecondaryLabel}</span>
            </SolidLink>
          </CtaButtons>
        </CtaWrap>
      )}

      <FooterEl>
        <FooterInner>
          <FooterBrand>
            <h3>ARC·AI</h3>
            <p>
              An autonomous, real-time conversational agent with RAG memory, live web research,
              proactive automation, and multi-workspace execution — built on the MERN stack.
            </p>
          </FooterBrand>

          <FooterCol>
            <h4>Product</h4>
            {NAV_LINKS.map((item) => (
              <Link key={item.to} to={item.to}>{item.label}</Link>
            ))}
          </FooterCol>

          <FooterCol>
            <h4>Connect</h4>
            <a href={LINKS.repo} target="_blank" rel="noopener noreferrer"><GithubIcon /> Source code</a>
            <a href={LINKS.github} target="_blank" rel="noopener noreferrer"><GithubIcon /> @Aashutosh31</a>
            <a href={LINKS.linkedin} target="_blank" rel="noopener noreferrer"><LinkedinIcon /> LinkedIn</a>
            <a href={LINKS.x} target="_blank" rel="noopener noreferrer"><XIcon /> @Aashutosh_dev31</a>
            <a href={LINKS.youtube} target="_blank" rel="noopener noreferrer"><YoutubeIcon /> Full demo</a>
          </FooterCol>
        </FooterInner>

        <FooterBottom>
          <span>© {new Date().getFullYear()} ARC-AI · Built by Aashutosh Bairagi</span>
          <a href={LINKS.repo} target="_blank" rel="noopener noreferrer">MIT Licensed — attribution required</a>
        </FooterBottom>
      </FooterEl>
    </Page>
  );
};

export default SeoPageLayout;

















