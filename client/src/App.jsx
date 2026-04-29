import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './components/SocketProvider';
import { ChatProvider } from './contexts/ChatContext';
import AuthPage from './pages/AuthPage';
import DashboardPage from './pages/DashboardPage';
import Features from './pages/Features';
import RAGMemory from './pages/RAGMemory';
import WebResearch from './pages/WebResearch';
import Automation from './pages/Automation';
import Architecture from './pages/Architecture';
import About from './pages/About';
import styled, { createGlobalStyle } from 'styled-components';

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
  }

  button, input, textarea {
    font-family: inherit;
  }
`;

const GlobalContainer = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
`;

const App = () => {
  return (
    <Router>
      <SocketProvider>
        <ChatProvider>
          <GlobalStyle />
          <GlobalContainer>
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
          </GlobalContainer>
        </ChatProvider>
      </SocketProvider>
    </Router>
  );
};

export default App;