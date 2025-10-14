// client/src/hooks/useVoiceInput.js
import { useState, useRef, useEffect } from 'react';
import { useSocket } from './useSocket';

// Get the browser-native speech recognition object
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const useVoiceInput = () => {
    const { socket, isConnected } = useSocket();
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const recognitionRef = useRef(null);

    // --- Core STT Logic ---
    const startListening = () => {
        if (!SpeechRecognition) {
            alert('Web Speech API is not supported in this browser. Please use Chrome or Edge.');
            return;
        }
        if (!isConnected) {
             alert('Server not connected. Check backend status.');
             return;
        }

        // 1. Initialize recognition instance
        const recognition = new SpeechRecognition();
        recognition.continuous = false; // Stop after a single phrase
        recognition.interimResults = true; // CRITICAL for real-time fragments
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            setIsListening(true);
            setTranscript('');
            console.log('🎙️ ARC-AI: Listening...');
        };

        // 2. Real-Time Fragment Handling (ai:stt:fragment)
        recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; i++) {
                const transcription = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += transcription;
                } else {
                    interimTranscript += transcription;
                }
            }

            // Update state with the most recent text (final + interim)
            const currentText = finalTranscript || interimTranscript;
            setTranscript(currentText);

            // Stream the fragment back to the server for live UI feedback (typing effect)
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
            if (transcript.trim().length > 0) {
                console.log(`🧠 ARC-AI: Sending final command: "${transcript}"`);
                // Send final command to the server for NLP processing
                if (socket) {
                    socket.emit('ai:stt:final', {
                        command: transcript,
                        userId: localStorage.getItem('userId'),
                    });
                }
            }
        };

        recognition.onerror = (event) => {
            setIsListening(false);
            console.error('STT Error:', event.error);
            setTranscript(`Error: ${event.error}`);
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
        transcript,
        startListening,
        stopListening,
    };
};