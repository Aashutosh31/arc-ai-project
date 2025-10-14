// client/src/App.jsx (Refined version)
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { SocketProvider } from './components/SocketProvider';
import AuthPage from './pages/AuthPage';
import DashboardPage from './pages/DashboardPage'; // We will create this next
import styled from 'styled-components';

const GlobalContainer = styled.div`
    min-height: 100vh;
    background-color: #0A0A1A; 
    color: #00FFFF; 
    display: flex;
    justify-content: center;
    align-items: center;
`;

// A simple wrapper to check for token and control access
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
                <GlobalContainer>
                    <Routes>
                        <Route path="/login" element={<AuthPage isRegister={false} />} />
                        <Route path="/register" element={<AuthPage isRegister={true} />} />

                        {/* Dashboard is protected */}
                        <Route 
                            path="/dashboard" 
                            element={
                                <ProtectedRoute>
                                    <DashboardPage />
                                </ProtectedRoute>
                            } 
                        />

                        {/* Redirect root to protected route or login */}
                        <Route path="/" element={<Navigate to="/dashboard" replace />} />
                    </Routes>
                </GlobalContainer>
            </SocketProvider>
        </Router>
    );
};

export default App;