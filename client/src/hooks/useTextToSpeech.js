import { useRef, useCallback } from 'react';
import { useChat } from '../contexts/ChatContext'; // 🚀 FIX: Import global context

const cleanTextForSpeech = (text) => {
  let cleaned = text.replace(/https?:\/\/[^\s]+/g, 'a link');
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  cleaned = cleaned.replace(/[-*=]{2,}/g, '. ');
  cleaned = cleaned.replace(/[=<-]-+[=>]?|[=<]=+[=>]?/g, ' ');
  cleaned = cleaned.replace(/(^|\s)[-*+]\s/g, ' ');
  cleaned = cleaned.replace(/[#_`~<>*]/g, '');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned.trim();
};

export const useTextToSpeech = () => {
  const { setIsSpeaking } = useChat(); // 🚀 FIX: Use Global State
  const sentenceBuffer = useRef(''); 

  const speak = useCallback((text) => {
    const textToSpeak = cleanTextForSpeech(text);
    if (!('speechSynthesis' in window) || !textToSpeak) return;
    
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.rate = 1.1; 
    utterance.pitch = 0.9;
    
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      // Small timeout to prevent UI flickering between sentences
      setTimeout(() => {
        if (!window.speechSynthesis.pending && !window.speechSynthesis.speaking) {
          setIsSpeaking(false);
        }
      }, 150);
    };
    
    window.speechSynthesis.speak(utterance);
  }, [setIsSpeaking]);

  const processStreamChunk = useCallback((chunk, isFinal) => {
    if (chunk) sentenceBuffer.current += chunk;

    const sentenceEndRegex = /[.!?\n]/;
    if (sentenceEndRegex.test(chunk) || isFinal) {
        const sentenceToSpeak = sentenceBuffer.current.trim();
        if (sentenceToSpeak) speak(sentenceToSpeak);
        sentenceBuffer.current = '';
    }
  }, [speak]);

  const stop = useCallback(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      sentenceBuffer.current = ''; 
      setIsSpeaking(false); // Instantly turn off speaking state
    }
  }, [setIsSpeaking]);

  return { speak, processStreamChunk, stop }; // No longer needs to return isSpeaking
};