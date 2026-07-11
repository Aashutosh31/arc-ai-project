import React, { Suspense, lazy } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './components/SocketProvider';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import { ChatProvider } from './contexts/ChatContext';
import { ExecutionProvider } from './contexts/ExecutionContext';
import styled, { createGlobalStyle } from 'styled-components';
import { Analytics } from "@vercel/analytics/react"

const AuthPage = lazy(() => import('./pages/AuthPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const Features = lazy(() => import('./pages/Features'));
const RAGMemory = lazy(() => import('./pages/RAGMemory'));
const WebResearch = lazy(() => import('./pages/WebResearch'));
const Automation = lazy(() => import('./pages/Automation'));
const Architecture = lazy(() => import('./pages/Architecture'));
const About = lazy(() => import('./pages/About'));

// 🚀 UPGRADE: We define Global CSS Variables for our Themes!
const GlobalStyle = createGlobalStyle`
  :root {
    --primary-hex: #00ffff;
    --primary-rgb: 0, 255, 255;
    --secondary-hex: #ff00ff;
    --secondary-rgb: 255, 0, 255;
    --bg-color: #020314;
    --chat-bg: rgba(10, 10, 30, 0.7);
  }

  [data-theme="hacker"] {
    --primary-hex: #00ff00;
    --primary-rgb: 0, 255, 0;
    --secondary-hex: #00aa00;
    --secondary-rgb: 0, 170, 0;
    --bg-color: #001100;
    --chat-bg: rgba(0, 20, 0, 0.8);
  }

  [data-theme="alert"] {
    --primary-hex: #ff0000;
    --primary-rgb: 255, 0, 0;
    --secondary-hex: #ff5555;
    --secondary-rgb: 255, 85, 85;
    --bg-color: #1a0000;
    --chat-bg: rgba(30, 0, 0, 0.8);
  }

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
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: var(--bg-color);
    color: #f5f5f5;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
    text-rendering: optimizeLegibility;
  }

  button, input, textarea {
    font-family: inherit;
    -webkit-tap-highlight-color: transparent;
  }

  :focus-visible {
    outline: 2px solid rgba(0, 255, 255, 0.75);
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
  color: #d7faff;
  background:
    radial-gradient(circle at top, rgba(0, 255, 255, 0.08), transparent 30%),
    linear-gradient(180deg, #030712 0%, #01040b 100%);
`;

const LoadingCard = styled.div`
  width: min(92vw, 360px);
  padding: 24px;
  border-radius: 18px;
  border: 1px solid rgba(0, 255, 255, 0.22);
  background: rgba(10, 10, 26, 0.8);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.45);
`;

const LoadingBar = styled.div`
  height: 4px;
  width: 100%;
  margin-top: 16px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;

  &::after {
    content: '';
    display: block;
    width: 40%;
    height: 100%;
    border-radius: inherit;
    background: linear-gradient(90deg, #00ffff, #8a2be2, #ff00ff);
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