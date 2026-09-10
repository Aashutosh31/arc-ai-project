import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './components/SocketProvider';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import { ChatProvider } from './contexts/ChatContext';
import { ExecutionProvider } from './contexts/ExecutionContext';
import styled, { createGlobalStyle } from 'styled-components';
import { Analytics } from "@vercel/analytics/react"
import { applyTheme, getStoredTheme } from './utils/theme';

// Apply the persisted theme before first render so reloads never flash
// the default theme and every mount starts from the single source of truth.
applyTheme(getStoredTheme());

const AuthPage = lazy(() => import('./pages/AuthPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const Features = lazy(() => import('./pages/Features'));
const RAGMemory = lazy(() => import('./pages/RAGMemory'));
const WebResearch = lazy(() => import('./pages/WebResearch'));
const Automation = lazy(() => import('./pages/Automation'));
const Architecture = lazy(() => import('./pages/Architecture'));
const About = lazy(() => import('./pages/About'));

// Theme values come from styles/arc.css (Tailwind v4 + daisyUI custom themes
// + ARC bridge). This GlobalStyle owns only structural/global CSS and the
// loading fallback. Adding a theme never touches this file.
const GlobalStyle = createGlobalStyle`
  *, *::before, *::after {
    box-sizing: border-box;
  }

  html, body, #root {
    margin: 0;
    padding: 0;
    height: 100%;
    transition: background-color 0.5s ease; /* Smooth fade when theme changes */
  }

  body {
    font-family: var(--font-body);
    background: var(--background);
    color: var(--foreground);
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
    text-rendering: optimizeLegibility;
  }

  button, input, textarea {
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  :focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 3px;
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`;

const GlobalContainer = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const LoadingScreen = styled.div`
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 24px;
  color: var(--foreground-muted);
  background:
    radial-gradient(circle at top, rgba(var(--primary-rgb), 0.08), transparent 30%),
    linear-gradient(180deg, var(--background-subtle) 0%, var(--background) 100%);
`;

const LoadingCard = styled.div`
  width: min(92vw, 360px);
  padding: 24px;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(var(--primary-rgb), 0.22);
  background: var(--surface-overlay);
  box-shadow: var(--shadow-lg);
`;

const LoadingBar = styled.div`
  height: 4px;
  width: 100%;
  margin-top: 16px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;

  &::after {
    content: '';
    display: block;
    width: 40%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, var(--primary), var(--accent), var(--secondary));
    animation: loadingSlide 1.2s ease-in-out infinite;
  }

  @keyframes loadingSlide {
    0% { transform: translateX(-120%); }
    100% { transform: translateX(280%); }
  }
`;

const App = () => {
  return (
    <Router>
      <SocketProvider>
        <WorkspaceProvider>
          <ChatProvider>
            <ExecutionProvider>
              <GlobalStyle />
              <GlobalContainer>
                <Suspense fallback={(
                  <LoadingScreen>
                    <LoadingCard>
                      <div>Loading ARC-AI...</div>
                      <LoadingBar />
                    </LoadingCard>
                  </LoadingScreen>
                )}>
                  <Routes>
                    <Route path="/" element={<Navigate to="/features" replace />} />
                    <Route path="/features" element={<Features />} />
                    <Route path="/features/rag-memory" element={<RAGMemory />} />
                    <Route path="/features/web-research" element={<WebResearch />} />
                    <Route path="/features/automation" element={<Automation />} />
                    <Route path="/architecture" element={<Architecture />} />
                    <Route path="/about" element={<About />} />
                    <Route path="/login" element={<AuthPage isRegister={false} />} />
                    <Route path="/register" element={<AuthPage isRegister={true} />} />
                    <Route path="/dashboard" element={<DashboardPage />} />
                  </Routes>
                </Suspense>
              </GlobalContainer>
            </ExecutionProvider>
          </ChatProvider>
        </WorkspaceProvider>
      </SocketProvider>
    </Router>
  );
};

export default App;