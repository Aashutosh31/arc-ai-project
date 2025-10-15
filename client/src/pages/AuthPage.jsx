// client/src/pages/AuthPage.jsx

import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import styled, { keyframes } from 'styled-components';

// Animations
const float = keyframes`
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-20px); }
`;

const glow = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
`;

const shimmer = keyframes`
  0% { background-position: -1000px 0; }
  100% { background-position: 1000px 0; }
`;

const particleFloat = keyframes`
  0% { transform: translate(0, 0) rotate(0deg); opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { transform: translate(100px, -100vh) rotate(360deg); opacity: 0; }
`;

// Main container with dark background and particle effects
const PageWrapper = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at bottom, #0d1b2a 0%, #000000 100%);
  position: relative;
  overflow: hidden;
  
  &::before {
    content: '';
    position: absolute;
    width: 200%;
    height: 200%;
    background: 
      linear-gradient(90deg, transparent 0%, rgba(0, 255, 255, 0.03) 50%, transparent 100%),
      linear-gradient(0deg, transparent 0%, rgba(138, 43, 226, 0.03) 50%, transparent 100%);
    animation: ${shimmer} 20s linear infinite;
  }
`;

// Floating particles
const Particle = styled.div`
  position: absolute;
  width: ${props => props.size || 4}px;
  height: ${props => props.size || 4}px;
  background: ${props => props.color || 'rgba(0, 255, 255, 0.6)'};
  border-radius: 50%;
  bottom: -10px;
  left: ${props => props.left || 0}%;
  animation: ${particleFloat} ${props => props.duration || 15}s linear infinite;
  animation-delay: ${props => props.delay || 0}s;
  box-shadow: 0 0 20px ${props => props.color || 'rgba(0, 255, 255, 0.8)'};
`;

const ParticleContainer = styled.div`
  position: absolute;
  width: 100%;
  height: 100%;
  overflow: hidden;
`;

// Glassmorphic Auth Container
const AuthContainer = styled.div`
  background: rgba(10, 10, 26, 0.7);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  padding: 50px 40px;
  border-radius: 24px;
  border: 1px solid rgba(0, 255, 255, 0.2);
  box-shadow: 
    0 8px 32px 0 rgba(0, 0, 0, 0.5),
    0 0 80px rgba(0, 255, 255, 0.15),
    inset 0 0 20px rgba(138, 43, 226, 0.1);
  width: 420px;
  color: #fff;
  position: relative;
  z-index: 10;
  animation: ${float} 6s ease-in-out infinite;
  
  &::before {
    content: '';
    position: absolute;
    top: -2px;
    left: -2px;
    right: -2px;
    bottom: -2px;
    background: linear-gradient(45deg, #00ffff, #8a2be2, #ff00ff, #00ffff);
    border-radius: 24px;
    z-index: -1;
    opacity: 0;
    transition: opacity 0.3s ease;
  }
  
  &:hover::before {
    opacity: 0.3;
    animation: ${shimmer} 3s linear infinite;
  }
`;

// Title with neon glow
const Title = styled.h1`
  font-size: 32px;
  font-weight: 700;
  text-align: center;
  margin-bottom: 10px;
  background: linear-gradient(135deg, #00ffff 0%, #8a2be2 50%, #ff00ff 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  text-shadow: 0 0 30px rgba(0, 255, 255, 0.5);
  letter-spacing: 2px;
  animation: ${glow} 3s ease-in-out infinite;
`;

const Subtitle = styled.p`
  text-align: center;
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;
  margin-bottom: 30px;
  letter-spacing: 1px;
`;

// Form styling
const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 20px;
`;

const InputGroup = styled.div`
  position: relative;
`;

const InputLabel = styled.label`
  display: block;
  color: rgba(0, 255, 255, 0.8);
  font-size: 12px;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-weight: 600;
`;

const Input = styled.input`
  width: 100%;
  padding: 14px 18px;
  border: 1px solid rgba(0, 191, 255, 0.3);
  background: rgba(0, 0, 0, 0.4);
  color: #00ffff;
  border-radius: 12px;
  font-size: 15px;
  transition: all 0.3s ease;
  outline: none;
  
  &::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }
  
  &:focus {
    border-color: #00ffff;
    background: rgba(0, 0, 0, 0.6);
    box-shadow: 
      0 0 20px rgba(0, 255, 255, 0.3),
      inset 0 0 10px rgba(0, 255, 255, 0.1);
  }
  
  &:hover {
    border-color: rgba(138, 43, 226, 0.5);
  }
`;

const Button = styled.button`
  padding: 16px 24px;
  margin-top: 10px;
  background: linear-gradient(135deg, #00ffff 0%, #8a2be2 50%, #ff00ff 100%);
  background-size: 200% 200%;
  color: #000;
  font-weight: 700;
  font-size: 16px;
  border: none;
  border-radius: 12px;
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 2px;
  position: relative;
  overflow: hidden;
  transition: all 0.3s ease;
  box-shadow: 0 4px 15px rgba(0, 255, 255, 0.4);
  
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
    transition: left 0.5s ease;
  }
  
  &:hover {
    transform: translateY(-2px);
    box-shadow: 0 8px 25px rgba(138, 43, 226, 0.6);
    background-position: 100% 0;
  }
  
  &:hover::before {
    left: 100%;
  }
  
  &:active {
    transform: translateY(0);
  }
`;

const ToggleText = styled.p`
  text-align: center;
  margin-top: 25px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;
`;

const ToggleLink = styled.span`
  color: #00ffff;
  cursor: pointer;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.3s ease;
  
  &:hover {
    color: #8a2be2;
    text-shadow: 0 0 10px rgba(138, 43, 226, 0.8);
  }
`;

// AI Neural network grid background
const NeuralGrid = styled.div`
  position: absolute;
  width: 100%;
  height: 100%;
  background-image: 
    linear-gradient(rgba(0, 255, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 255, 255, 0.05) 1px, transparent 1px);
  background-size: 50px 50px;
  animation: ${shimmer} 15s linear infinite;
  opacity: 0.3;
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
      
      localStorage.setItem('token', token);
      localStorage.setItem('userId', _id);
      
      navigate('/dashboard');
      window.location.reload();
    } catch (error) {
      alert(`Authentication failed: ${error.response?.data?.message || 'Server error'}`);
    }
  };

  // Generate particles
  const particles = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    size: Math.random() * 4 + 2,
    left: Math.random() * 100,
    duration: Math.random() * 10 + 15,
    delay: Math.random() * 5,
    color: i % 3 === 0 ? 'rgba(0, 255, 255, 0.6)' : i % 3 === 1 ? 'rgba(138, 43, 226, 0.6)' : 'rgba(255, 0, 255, 0.6)'
  }));

  return (
    <PageWrapper>
      <NeuralGrid />
      <ParticleContainer>
        {particles.map(particle => (
          <Particle
            key={particle.id}
            size={particle.size}
            left={particle.left}
            duration={particle.duration}
            delay={particle.delay}
            color={particle.color}
          />
        ))}
      </ParticleContainer>
      
      <AuthContainer>
        <Title>ARC-AI</Title>
        <Subtitle>{isRegister ? 'Initialize Neural Interface' : 'Activate Neural Connection'}</Subtitle>
        
        <Form onSubmit={handleSubmit}>
          {isRegister && (
            <InputGroup>
              <InputLabel>Username</InputLabel>
              <Input
                type="text"
                placeholder="Enter your identity"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
              />
            </InputGroup>
          )}
          
          <InputGroup>
            <InputLabel>Email</InputLabel>
            <Input
              type="email"
              placeholder="neural@interface.ai"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </InputGroup>
          
          <InputGroup>
            <InputLabel>Password</InputLabel>
            <Input
              type="password"
              placeholder="Enter secure passphrase"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </InputGroup>
          
          <Button type="submit">
            {isRegister ? 'Initialize System' : 'Activate Interface'}
          </Button>
        </Form>
        
        <ToggleText>
          {isRegister ? 'Already connected? ' : 'New to the network? '}
          <ToggleLink onClick={() => navigate(isRegister ? '/login' : '/register')}>
            {isRegister ? 'Login' : 'Register'}
          </ToggleLink>
        </ToggleText>
      </AuthContainer>
    </PageWrapper>
  );
};

export default AuthPage;
