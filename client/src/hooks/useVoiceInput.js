import { useState, useRef, useEffect } from 'react';
import { useChat } from '../contexts/ChatContext';
import { useSocket } from './useSocket';

// Get the browser-native speech recognition object
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const useVoiceInput = () => {
    // 🚀 FIX 2: We extract 'sendCommand' to display your voice text in the UI
    const { socket, isConnected, sendCommand } = useSocket();
    const { setIsVoiceListening } = useChat();
    
    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const recognitionRef = useRef(null);
    const finalCommandRef = useRef(''); 

    const startListening = () => {
        if (!SpeechRecognition) {
            alert('Web Speech API is not supported in this browser. Please use Chrome or Edge.');
            return;
        }
        if (!isConnected) {
             alert('Server not connected. Check backend status.');
             return;
        }

        if (isListening) return; 

        const recognition = new SpeechRecognition();
        recognition.continuous = false; 
        recognition.interimResults = true; 
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            setIsListening(true);
            setIsVoiceListening(true);
            setTranscript('');
            finalCommandRef.current = ''; 
        };

        recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }

            setTranscript(finalTranscript || interimTranscript);

            if (finalTranscript) {
                const definitiveCommand = finalTranscript.trim();
                finalCommandRef.current = definitiveCommand; 
                
                // 🚀 FIX 2: Use sendCommand instead of a raw socket.emit!
                if (sendCommand && definitiveCommand) {
                    sendCommand(definitiveCommand);
                }
                
                setTranscript('');
            }
        };

        recognition.onerror = (event) => {
            setIsListening(false);
            setIsVoiceListening(false);
            console.error('STT Error:', event.error);
            setTranscript(`Error: ${event.error}`);

            if (event.error === 'network' || event.error === 'aborted') {
                 console.log("Attempting graceful restart of STT...");
                 setTimeout(startListening, 500); 
            }
        };

        recognition.onend = () => {
            setIsListening(false);
            setIsVoiceListening(false);
        };

        recognitionRef.current = recognition;
        recognition.start();
    };

    const stopListening = () => {
        if (recognitionRef.current) {
            recognitionRef.current.stop();
        }
        setIsVoiceListening(false);
    };
    
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