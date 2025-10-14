// client/src/pages/AuthPage.jsx
import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import styled from 'styled-components';

const AuthContainer = styled.div`
    /* Futuristic UI styles */
    background: #111;
    padding: 40px;
    border-radius: 10px;
    border: 1px solid #00FFFF;
    box-shadow: 0 0 20px #00FFFF88;
    width: 350px;
    color: #fff;
`;
const Input = styled.input`
    width: 100%;
    padding: 10px;
    margin: 10px 0;
    border: 1px solid #00BFFF;
    background: rgba(0, 0, 0, 0.4);
    color: #00FFFF;
    border-radius: 5px;
`;
const Button = styled.button`
    padding: 10px 20px;
    margin-top: 20px;
    background: linear-gradient(90deg, #00FFFF, #FF00FF);
    color: #0A0A1A;
    font-weight: bold;
    border: none;
    border-radius: 5px;
    cursor: pointer;
`;

const AuthPage = ({ isRegister }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [username, setUsername] = useState('');
    const navigate = useNavigate();
    const API_URL = import.meta.env.VITE_API_URL;

    const handleSubmit = async (e) => {
        e.preventDefault();
        const endpoint = isRegister ? 'register' : 'login';
        const data = { email, password };
        if (isRegister) data.username = username;

        try {
            const res = await axios.post(`${API_URL}/api/auth/${endpoint}`, data);
            const { token, _id } = res.data;

            // --- CRITICAL FIX: Store Token and ID ---
            localStorage.setItem('token', token);
            localStorage.setItem('userId', _id);

            // Navigate to the main application page
            navigate('/dashboard'); 
            window.location.reload(); // Force a full refresh to reconnect Socket.IO with new token
        } catch (error) {
            alert(`Authentication failed: ${error.response?.data?.message || 'Server error'}`);
        }
    };

    return (
        <AuthContainer>
            <h2>{isRegister ? 'ARC-AI Registration' : 'ARC-AI Login'}</h2>
            <form onSubmit={handleSubmit}>
                {isRegister && (
                    <Input
                        type="text"
                        placeholder="Username"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        required
                    />
                )}
                <Input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
                <Input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                />
                <Button type="submit">{isRegister ? 'Register & Initialize' : 'Login & Activate'}</Button>
            </form>
            <p style={{ marginTop: '15px' }}>
                {isRegister ? 'Already have an account? ' : "Don't have an account? "}
                <span 
                    style={{ color: '#FF00FF', cursor: 'pointer' }}
                    onClick={() => navigate(isRegister ? '/login' : '/register')}
                >
                    {isRegister ? 'Login' : 'Register'}
                </span>
            </p>
        </AuthContainer>
    );
};

export default AuthPage;