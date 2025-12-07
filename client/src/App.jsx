// client/src/App.jsx
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './components/SocketProvider';
import { ChatProvider } from './contexts/ChatContext';
import AuthPage from './pages/AuthPage';
import DashboardPage from './pages/DashboardPage';
import styled, { createGlobalStyle } from 'styled-components';

const GlobalStyle = createGlobalStyle`
  *, *::before, *::after {
    box-sizing: border-box;
  }

  html, body, #root {
    margin: 0;
    padding: 0;
    height: 100%;
  }

  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #020314;
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

// ProtectedRoute stays the same (logic unchanged)
const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

const App = () => {
  return (
    <Router>
      <SocketProvider>
        <ChatProvider>
          <GlobalStyle />
          <GlobalContainer>
            <Routes>
              <Route path="/login" element={<AuthPage isRegister={false} />} />
              <Route path="/register" element={<AuthPage isRegister={true} />} />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </GlobalContainer>
        </ChatProvider>
      </SocketProvider>
    </Router>
  );
};

export default App;
