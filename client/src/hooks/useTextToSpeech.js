// client/src/hooks/useTextToSpeech.js (COMPLETE CODE)
import { useState, useEffect } from 'react';

// This custom hook wraps the browser's native, free SpeechSynthesis API.
const useTextToSpeech = () => {
    const [isSpeaking, setIsSpeaking] = useState(false);
    
    const synth = window.speechSynthesis;

    useEffect(() => {
        if (!synth) {
            console.warn('Text-to-Speech is not supported in this browser.');
        }
    }, [synth]);

    const speak = (text) => {
        if (!synth || !text) return;

        // Stop any current speech
        if (synth.speaking) {
            synth.cancel();
        }

        const utterance = new SpeechSynthesisUtterance(text);
        
        // Optional: Customize voice/rate for the futuristic ARC-AI feel
        utterance.rate = 1.05; // Slightly faster for an AI effect

        utterance.onstart = () => setIsSpeaking(true);
        utterance.onend = () => setIsSpeaking(false);
        utterance.onerror = (event) => {
            console.error('TTS Error:', event.error);
            setIsSpeaking(false);
        };

        synth.speak(utterance);
    };

    const stop = () => {
        if (synth.speaking) {
            synth.cancel();
            setIsSpeaking(false);
        }
    };

    return { speak, stop, isSpeaking };
};

export default useTextToSpeech;