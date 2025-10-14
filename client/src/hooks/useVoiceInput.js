// client/src/hooks/useVoiceInput.js (COMPLETE CODE with fixes for lag and errors)
import { useState, useRef, useEffect } from 'react';
import { useSocket } from './useSocket';
import { useChat } from '../contexts/ChatContext.jsx'; 

// Get the browser-native speech recognition object
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const useVoiceInput = () => {
    const { socket, isConnected } = useSocket();
    const { addMessage } = useChat();
    
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const recognitionRef = useRef(null);
    const finalCommandRef = useRef(''); // CRITICAL FIX for command -1 bug

    const startListening = () => {
        if (!SpeechRecognition) {
            alert('Web Speech API is not supported in this browser. Please use Chrome or Edge.');
            return;
        }
        if (!isConnected) {
             alert('Server not connected. Check backend status.');
             return;
        }

        if (isListening) return; // Prevent double start

        // 1. Initialization and Setup
        const recognition = new SpeechRecognition();
        recognition.continuous = false; 
        recognition.interimResults = true; 
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            setIsListening(true);
            setTranscript('');
            finalCommandRef.current = ''; // Reset the ref on start
            console.log('🎙️ ARC-AI: Listening...');
        };

        // 2. Real-Time Fragment Handling (ai:stt:fragment)
        recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcription = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    // Accumulate final text (in case of multiple short phrases)
                    finalTranscript += transcription;
                } else {
                    interimTranscript += transcription;
                }
            }

            const currentText = finalTranscript || interimTranscript;
            setTranscript(currentText);

            // CRITICAL FIX: Update the ref with the DEFINITIVE final command
            if (finalTranscript) {
                finalCommandRef.current = finalTranscript;
            }

            // Stream the current text (fragment or final) for live UI feedback
            if (socket) {
                socket.emit('ai:stt:fragment', { 
                    text: currentText, 
                    userId: localStorage.getItem('userId') 
                });
            }
        };

        // 3. Command Finalization (ai:stt:final)
        recognition.onend = () => {
            setIsListening(false);
            const definitiveCommand = finalCommandRef.current.trim(); 

            if (definitiveCommand.length > 0) {
                console.log(`🧠 ARC-AI: Sending definitive command: "${definitiveCommand}"`);
                
                // 1. ADD USER MESSAGE TO HISTORY
                addMessage('user', definitiveCommand); 
                
                // 2. Send final command to the server 
                if (socket) {
                    socket.emit('ai:stt:final', {
                        command: definitiveCommand, 
                        userId: localStorage.getItem('userId'),
                    });
                }
            }
             // Reset the displayed transcript after processing
             setTranscript('');
        };

        recognition.onerror = (event) => {
            setIsListening(false);
            console.error('STT Error:', event.error);
            setTranscript(`Error: ${event.error}`);

            // --- GRACEFUL RESTART LOGIC (Step 4.18 Fix) ---
            if (event.error === 'network' || event.error === 'aborted') {
                 console.log("Attempting graceful restart of STT...");
                 setTimeout(startListening, 500); 
            }
        };

        recognitionRef.current = recognition;
        recognition.start();
    };

    const stopListening = () => {
        if (recognitionRef.current) {
            recognitionRef.current.stop();
        }
    };
    
    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
            }
        };
    }, []);

    return {
        isListening,
        transcript, // This is what the UI displays while speaking
        startListening,
        stopListening,
    };
};