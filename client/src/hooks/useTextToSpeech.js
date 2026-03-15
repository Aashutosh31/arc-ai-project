import { useState, useRef, useCallback } from 'react';

export const useTextToSpeech = () => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const sentenceBuffer = useRef(''); // Holds words until a sentence is formed

  const speak = useCallback((text) => {
    if (!('speechSynthesis' in window) || !text) return;
    
    const utterance = new SpeechSynthesisUtterance(text);
    
    // Optional: Make it sound more like Jarvis (faster, deeper)
    utterance.rate = 1.1; 
    utterance.pitch = 0.9;
    
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      // Only set to false if the queue is entirely empty
      if (window.speechSynthesis.pending === false) {
        setIsSpeaking(false);
      }
    };
    
    window.speechSynthesis.speak(utterance);
  }, []);

  // NEW: Processes incoming chunks for real-time speech
  const processStreamChunk = useCallback((chunk, isFinal) => {
    if (chunk) {
        sentenceBuffer.current += chunk;
    }

    // Regex to detect end of sentences (., !, ?, or newlines)
    const sentenceEndRegex = /[.!?\n]/;

    if (sentenceEndRegex.test(chunk) || isFinal) {
        const sentenceToSpeak = sentenceBuffer.current.trim();
        if (sentenceToSpeak) {
            speak(sentenceToSpeak);
        }
        // Clear the buffer for the next sentence
        sentenceBuffer.current = '';
    }
  }, [speak]);

  const stop = useCallback(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      sentenceBuffer.current = ''; // clear buffer on stop
      setIsSpeaking(false);
    }
  }, []);

  return { isSpeaking, speak, processStreamChunk, stop };
};
