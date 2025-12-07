// client/src/pages/AuthPage.jsx

import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import styled, { keyframes } from 'styled-components';

// Animations
const float = keyframes`
  0%, 100% { transform: translateY(0px); }
  50% { transform: translateY(-10px); }
`;

const glow = keyframes`
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
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

const slideIn = keyframes`
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
`;

const spin = keyframes`
  to { transform: rotate(360deg); }
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
  padding: 20px;
  
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

  @media (max-width: 768px) {
    padding: 10px;
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
  pointer-events: none;
`;

const ParticleContainer = styled.div`
  position: absolute;
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
`;

// Glassmorphic Auth Container
const AuthContainer = styled.div`
  background: rgba(10, 10, 26, 0.85);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  padding: 50px 40px;
  border-radius: 24px;
  border: 1px solid rgba(0, 255, 255, 0.2);
  box-shadow: 
    0 8px 32px 0 rgba(0, 0, 0, 0.5),
    0 0 80px rgba(0, 255, 255, 0.15),
    inset 0 0 20px rgba(138, 43, 226, 0.1);
  max-width: 440px;
  width: 100%;
  color: #fff;
  position: relative;
  z-index: 10;
  animation: ${float} 8s ease-in-out infinite;
  
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
    transition: opacity 0.5s ease;
  }
  
  &:hover::before {
    opacity: 0.2;
  }

  @media (max-width: 768px) {
    padding: 40px 30px;
    border-radius: 20px;
  }

  @media (max-width: 480px) {
    padding: 30px 20px;
  }
`;

// Title with neon glow
const Title = styled.h1`
  font-size: 36px;
  font-weight: 700;
  text-align: center;
  margin-bottom: 8px;
  background: linear-gradient(135deg, #00ffff 0%, #8a2be2 50%, #ff00ff 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  filter: drop-shadow(0 0 20px rgba(0, 255, 255, 0.5));
  letter-spacing: 3px;
  animation: ${glow} 4s ease-in-out infinite;

  @media (max-width: 768px) {
    font-size: 32px;
  }

  @media (max-width: 480px) {
    font-size: 28px;
    letter-spacing: 2px;
  }
`;

const Subtitle = styled.p`
  text-align: center;
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;
  margin-bottom: 35px;
  letter-spacing: 1px;

  @media (max-width: 480px) {
    font-size: 13px;
    margin-bottom: 25px;
  }
`;

// Form styling
const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 24px;
`;

const InputGroup = styled.div`
  position: relative;
  animation: ${slideIn} 0.4s ease-out backwards;
  animation-delay: ${props => props.delay || '0s'};
`;

const InputLabel = styled.label`
  display: block;
  color: rgba(0, 255, 255, 0.9);
  font-size: 12px;
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 1.5px;
  font-weight: 600;
`;

const InputWrapper = styled.div`
  position: relative;
  display: flex;
  align-items: center;
`;

const Input = styled.input`
  width: 100%;
  padding: 16px 18px;
  padding-right: ${props => props.hasIcon ? '50px' : '18px'};
  border: 2px solid ${props => 
    props.error ? 'rgba(255, 0, 100, 0.5)' : 
    props.success ? 'rgba(0, 255, 100, 0.5)' : 
    'rgba(0, 191, 255, 0.3)'};
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
    border-color: ${props => 
      props.error ? 'rgba(255, 0, 100, 0.8)' : '#00ffff'};
    background: rgba(0, 0, 0, 0.6);
    box-shadow: 
      0 0 25px ${props => 
        props.error ? 'rgba(255, 0, 100, 0.3)' : 'rgba(0, 255, 255, 0.3)'},
      inset 0 0 15px ${props => 
        props.error ? 'rgba(255, 0, 100, 0.1)' : 'rgba(0, 255, 255, 0.1)'};
    transform: translateY(-2px);
  }
  
  &:hover:not(:focus) {
    border-color: rgba(138, 43, 226, 0.5);
  }

  @media (max-width: 480px) {
    padding: 14px 16px;
    padding-right: ${props => props.hasIcon ? '45px' : '16px'};
    font-size: 16px; /* Prevents zoom on iOS */
  }
`;

const PasswordToggle = styled.button`
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: rgba(0, 255, 255, 0.6);
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.3s ease;
  font-size: 18px;
  
  &:hover {
    color: #00ffff;
    transform: translateY(-50%) scale(1.1);
  }

  &:focus {
    outline: 2px solid rgba(0, 255, 255, 0.5);
    outline-offset: 2px;
    border-radius: 4px;
  }

  @media (max-width: 480px) {
    padding: 10px;
  }
`;

const PasswordStrengthBar = styled.div`
  height: 4px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 2px;
  margin-top: 8px;
  overflow: hidden;
  position: relative;

  &::after {
    content: '';
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    width: ${props => props.strength}%;
    background: ${props => 
      props.strength < 33 ? 'linear-gradient(90deg, #ff0050, #ff3366)' :
      props.strength < 66 ? 'linear-gradient(90deg, #ffa500, #ffcc00)' :
      'linear-gradient(90deg, #00ff88, #00ffcc)'};
    transition: all 0.3s ease;
    box-shadow: 0 0 10px ${props => 
      props.strength < 33 ? 'rgba(255, 0, 80, 0.5)' :
      props.strength < 66 ? 'rgba(255, 165, 0, 0.5)' :
      'rgba(0, 255, 136, 0.5)'};
  }
`;

const PasswordStrengthText = styled.span`
  font-size: 11px;
  color: ${props => 
    props.strength < 33 ? '#ff3366' :
    props.strength < 66 ? '#ffcc00' :
    '#00ff88'};
  margin-top: 6px;
  display: block;
  letter-spacing: 0.5px;
`;

const CheckboxWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  margin: -8px 0;
`;

const Checkbox = styled.input`
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: #00ffff;
  
  &:focus {
    outline: 2px solid rgba(0, 255, 255, 0.5);
    outline-offset: 2px;
  }
`;

const CheckboxLabel = styled.label`
  color: rgba(255, 255, 255, 0.7);
  font-size: 14px;
  cursor: pointer;
  user-select: none;
  transition: color 0.3s ease;

  &:hover {
    color: #00ffff;
  }
`;

const ErrorMessage = styled.div`
  background: rgba(255, 0, 80, 0.15);
  border: 1px solid rgba(255, 0, 80, 0.4);
  color: #ff3366;
  padding: 14px 16px;
  border-radius: 10px;
  font-size: 14px;
  margin-bottom: 10px;
  animation: ${slideIn} 0.3s ease-out;
  display: flex;
  align-items: center;
  gap: 10px;
  box-shadow: 0 0 15px rgba(255, 0, 80, 0.2);

  &::before {
    content: '⚠';
    font-size: 18px;
    flex-shrink: 0;
  }

  @media (max-width: 480px) {
    font-size: 13px;
    padding: 12px 14px;
  }
`;

const Button = styled.button`
  padding: 18px 24px;
  margin-top: 10px;
  background: ${props => props.disabled ? 
    'rgba(100, 100, 100, 0.3)' : 
    'linear-gradient(135deg, #00ffff 0%, #8a2be2 50%, #ff00ff 100%)'};
  background-size: 200% 200%;
  color: ${props => props.disabled ? 'rgba(255, 255, 255, 0.3)' : '#000'};
  font-weight: 700;
  font-size: 16px;
  border: none;
  border-radius: 12px;
  cursor: ${props => props.disabled ? 'not-allowed' : 'pointer'};
  text-transform: uppercase;
  letter-spacing: 2px;
  position: relative;
  overflow: hidden;
  transition: all 0.3s ease;
  box-shadow: ${props => props.disabled ? 
    'none' : 
    '0 4px 20px rgba(0, 255, 255, 0.4)'};
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 56px;
  
  &::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
    transition: left 0.6s ease;
  }
  
  &:hover:not(:disabled) {
    transform: translateY(-3px);
    box-shadow: 0 8px 30px rgba(138, 43, 226, 0.6);
    background-position: 100% 0;
  }
  
  &:hover:not(:disabled)::before {
    left: 100%;
  }
  
  &:active:not(:disabled) {
    transform: translateY(-1px);
  }

  &:focus {
    outline: 3px solid rgba(0, 255, 255, 0.5);
    outline-offset: 3px;
  }

  @media (max-width: 480px) {
    padding: 16px 20px;
    min-height: 52px;
    font-size: 15px;
  }
`;

const Spinner = styled.div`
  width: 20px;
  height: 20px;
  border: 3px solid rgba(0, 0, 0, 0.3);
  border-top-color: #000;
  border-radius: 50%;
  animation: ${spin} 0.8s linear infinite;
`;

const ToggleText = styled.p`
  text-align: center;
  margin-top: 30px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 14px;

  @media (max-width: 480px) {
    font-size: 13px;
    margin-top: 25px;
  }
`;

const ToggleLink = styled.span`
  color: #00ffff;
  cursor: pointer;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.3s ease;
  position: relative;
  
  &::after {
    content: '';
    position: absolute;
    bottom: -2px;
    left: 0;
    width: 0;
    height: 2px;
    background: linear-gradient(90deg, #00ffff, #8a2be2);
    transition: width 0.3s ease;
  }
  
  &:hover {
    color: #8a2be2;
    text-shadow: 0 0 15px rgba(138, 43, 226, 0.8);
  }

  &:hover::after {
    width: 100%;
  }

  &:focus {
    outline: 2px solid rgba(0, 255, 255, 0.5);
    outline-offset: 4px;
    border-radius: 2px;
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
  opacity: 0.3;
  pointer-events: none;
`;

const AuthPage = ({ isRegister }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [passwordStrength, setPasswordStrength] = useState(0);
  
  const navigate = useNavigate();
  const API_URL = import.meta.env.VITE_API_URL;

  // Calculate password strength
  const calculatePasswordStrength = (pass) => {
    let strength = 0;
    if (pass.length >= 8) strength += 25;
    if (pass.length >= 12) strength += 15;
    if (/[a-z]/.test(pass) && /[A-Z]/.test(pass)) strength += 20;
    if (/\d/.test(pass)) strength += 20;
    if (/[^a-zA-Z0-9]/.test(pass)) strength += 20;
    return Math.min(strength, 100);
  };

  const handlePasswordChange = (e) => {
    const newPassword = e.target.value;
    setPassword(newPassword);
    if (isRegister && newPassword) {
      setPasswordStrength(calculatePasswordStrength(newPassword));
    }
  };

  const getPasswordStrengthLabel = () => {
    if (passwordStrength < 33) return 'Weak';
    if (passwordStrength < 66) return 'Medium';
    return 'Strong';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const endpoint = isRegister ? 'register' : 'login';
    const data = { email, password };
    if (isRegister) data.username = username;

    try {
      const res = await axios.post(`${API_URL}/api/auth/${endpoint}`, data);
      const { token, _id } = res.data;
      
      localStorage.setItem('token', token);
      localStorage.setItem('userId', _id);
      
      if (rememberMe) {
        localStorage.setItem('rememberMe', 'true');
      }
      
      navigate('/dashboard');
      window.location.reload();
    } catch (err) {
      setError(err.response?.data?.message || 'Authentication failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Generate particles
  const particles = Array.from({ length: 15 }, (_, i) => ({
    id: i,
    size: Math.random() * 3 + 2,
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
        
        {error && <ErrorMessage>{error}</ErrorMessage>}
        
        <Form onSubmit={handleSubmit}>
          {isRegister && (
            <InputGroup delay="0.1s">
              <InputLabel htmlFor="username">Username</InputLabel>
              <InputWrapper>
                <Input
                  id="username"
                  type="text"
                  placeholder="Enter your identity"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoComplete="username"
                  aria-label="Username"
                />
              </InputWrapper>
            </InputGroup>
          )}
          
          <InputGroup delay={isRegister ? "0.2s" : "0.1s"}>
            <InputLabel htmlFor="email">Email</InputLabel>
            <InputWrapper>
              <Input
                id="email"
                type="email"
                placeholder="neural@interface.ai"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                aria-label="Email address"
              />
            </InputWrapper>
          </InputGroup>
          
          <InputGroup delay={isRegister ? "0.3s" : "0.2s"}>
            <InputLabel htmlFor="password">Password</InputLabel>
            <InputWrapper>
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                placeholder="Enter secure passphrase"
                value={password}
                onChange={handlePasswordChange}
                required
                autoComplete={isRegister ? "new-password" : "current-password"}
                hasIcon={true}
                aria-label="Password"
              />
              <PasswordToggle
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={0}
              >
                {showPassword ? '👁️' : '👁️‍🗨️'}
              </PasswordToggle>
            </InputWrapper>
            {isRegister && password && (
              <>
                <PasswordStrengthBar strength={passwordStrength} />
                <PasswordStrengthText strength={passwordStrength}>
                  Password strength: {getPasswordStrengthLabel()}
                </PasswordStrengthText>
              </>
            )}
          </InputGroup>

          {!isRegister && (
            <CheckboxWrapper>
              <Checkbox
                type="checkbox"
                id="rememberMe"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                aria-label="Remember me"
              />
              <CheckboxLabel htmlFor="rememberMe">
                Remember this device
              </CheckboxLabel>
            </CheckboxWrapper>
          )}
          
          <Button type="submit" disabled={loading}>
            {loading ? (
              <>
                <Spinner />
                Processing...
              </>
            ) : (
              isRegister ? 'Initialize System' : 'Activate Interface'
            )}
          </Button>
        </Form>
        
        <ToggleText>
          {isRegister ? 'Already connected? ' : 'New to the network? '}
          <ToggleLink 
            onClick={() => !loading && navigate(isRegister ? '/login' : '/register')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                !loading && navigate(isRegister ? '/login' : '/register');
              }
            }}
            tabIndex={0}
            role="button"
            aria-label={isRegister ? 'Go to login page' : 'Go to registration page'}
          >
            {isRegister ? 'Login' : 'Register'}
          </ToggleLink>
        </ToggleText>
      </AuthContainer>
    </PageWrapper>
  );
};

export default AuthPage;
