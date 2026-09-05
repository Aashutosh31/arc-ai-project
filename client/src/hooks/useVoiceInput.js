import { useState, useRef, useEffect } from 'react';
import { useChat } from '../contexts/ChatContext';
import { useSocket } from './useSocket';
import {
    getSpeechRecognitionClass,
    hasRecordingSTT,
    pickRecordingMimeType,
    transcribeAudioBlob
} from '../utils/voiceCapabilities';

const MAX_RECORDING_MS = 30000;

export const useVoiceInput = () => {
    // 🚀 FIX 2: We extract 'sendCommand' to display your voice text in the UI
    const { isConnected, sendCommand } = useSocket();
    const { setIsVoiceListening } = useChat();

    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState('');
    const recognitionRef = useRef(null);
    const finalCommandRef = useRef('');
    const fallbackRefs = useRef({ stream: null, recorder: null, chunks: [], capTimer: null });
    const fallbackErrorLoggedRef = useRef(false);

    const startListening = () => {
        if (!isConnected) {
             setTranscript('Server not connected. Check backend status.');
             return;
        }

        const SpeechRecognition = getSpeechRecognitionClass();
        if (!SpeechRecognition) {
            // Fallback: record a clip and transcribe it server-side.
            startRecordingFallback();
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

    const cleanupRecordingFallback = () => {
        const refs = fallbackRefs.current;
        clearTimeout(refs.capTimer);
        refs.capTimer = null;
        try {
            if (refs.recorder && refs.recorder.state !== 'inactive') refs.recorder.stop();
        } catch {
            // already stopped
        }
        refs.recorder = null;
        refs.chunks = [];
        try {
            refs.stream?.getTracks?.().forEach((track) => track.stop());
        } catch {
            // tracks already stopped
        }
        refs.stream = null;
    };

    const startRecordingFallback = async () => {
        if (isListening) return;
        if (!hasRecordingSTT()) {
            setTranscript('Voice input is not available in this browser. Please type your message instead.');
            if (!fallbackErrorLoggedRef.current) {
                fallbackErrorLoggedRef.current = true;
                console.warn('[VoiceInput] no voice capability (no SpeechRecognition, MediaRecorder, or microphone).');
            }
            return;
        }
        fallbackErrorLoggedRef.current = false;
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            setTranscript(err?.name === 'NotAllowedError'
                ? 'Microphone access was denied. Allow microphone permission, or type your message.'
                : 'Could not access the microphone. Type your message instead.');
            console.warn('[VoiceInput] microphone access failed:', err?.message || err);
            return;
        }
        const refs = fallbackRefs.current;
        refs.stream = stream;
        refs.chunks = [];
        const mimeType = pickRecordingMimeType();
        let recorder;
        try {
            recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        } catch (err) {
            setTranscript('Recording is not available in this browser. Please type your message instead.');
            console.warn('[VoiceInput] recorder init failed:', err?.message || err);
            cleanupRecordingFallback();
            return;
        }
        recorder.ondataavailable = (event) => {
            if (event?.data && event.data.size > 0) refs.chunks.push(event.data);
        };
        recorder.onstop = async () => {
            const blob = new Blob(refs.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
            refs.chunks = [];
            const tracksCleanup = () => {
                try {
                    refs.stream?.getTracks?.().forEach((track) => track.stop());
                } catch {
                    // ignore
                }
                refs.stream = null;
            };
            if (!blob || blob.size === 0) {
                tracksCleanup();
                setIsListening(false);
                setIsVoiceListening(false);
                return;
            }
            setTranscript('Transcribing…');
            try {
                const text = await transcribeAudioBlob(blob);
                if (text && sendCommand) sendCommand(text.trim());
                setTranscript(text || '');
            } catch (err) {
                setTranscript(err?.code === 'VOICE_STT_UNAVAILABLE'
                    ? 'Server voice transcription is not configured. Please type your message.'
                    : `Voice transcription failed (${err?.message || 'unknown error'}). Please type your message.`);
                console.warn('[VoiceInput] transcription failed:', err?.message || err);
            } finally {
                tracksCleanup();
                setIsListening(false);
                setIsVoiceListening(false);
            }
        };
        refs.recorder = recorder;
        try {
            recorder.start(250);
        } catch (err) {
            setTranscript('Recording could not start. Please type your message instead.');
            console.warn('[VoiceInput] recorder start failed:', err?.message || err);
            cleanupRecordingFallback();
            return;
        }
        refs.capTimer = setTimeout(() => stopListening(), MAX_RECORDING_MS);
        setIsListening(true);
        setIsVoiceListening(true);
        setTranscript('Recording… tap again to stop.');
    };

    const stopListening = () => {
        if (recognitionRef.current) {
            recognitionRef.current.stop();
        }
        if (fallbackRefs.current.recorder) {
            // onstop transcribes and resets state; just stop the recorder.
            try {
                if (fallbackRefs.current.recorder.state !== 'inactive') {
                    fallbackRefs.current.recorder.stop();
                    return;
                }
            } catch {
                // fall through to cleanup
            }
            cleanupRecordingFallback();
            setIsListening(false);
        }
        setIsVoiceListening(false);
    };

    useEffect(() => {
        return () => {
            if (recognitionRef.current) {
                recognitionRef.current.stop();
            }
            cleanupRecordingFallback();
        };
    }, []);

    return {
        isListening,
        transcript, 
        startListening,
        stopListening,
    };
};