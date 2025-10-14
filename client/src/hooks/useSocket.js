// client/src/hooks/useSocket.js
import { useContext } from 'react';
import { SocketContext } from '../contexts/SocketContext';

// Export the custom hook function
export const useSocket = () => useContext(SocketContext);