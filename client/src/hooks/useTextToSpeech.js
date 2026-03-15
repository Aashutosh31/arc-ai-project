import { useState, useRef, useCallback } from 'react';

// Helper function to strip markdown, emojis, and URLs so the voice sounds natural
const cleanTextForSpeech = (text) => {
  let cleaned = text;
  
  // 1. Remove Markdown characters (asterisks, hashes, underscores, backticks, tildes)
  cleaned = cleaned.replace(/[*#_`~]/g, '');
  
  // 2. Replace URLs with the word "a link" so it doesn't read out "h t t p s colon..."
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, 'a link');
  
  // 3. Remove Emojis using a Unicode property escape regex
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
  
  return cleaned.trim();
};

export const useTextToSpeech = () => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const sentenceBuffer = useRef(''); 

  const speak = useCallback((text) => {
    // Clean the text before passing it to the speech engine
    const textToSpeak = cleanTextForSpeech(text);
    
    if (!('speechSynthesis' in window) || !textToSpeak) return;
    
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    
    // Optional: Make it sound more like Jarvis (faster, deeper)
    utterance.rate = 1.1; 
    utterance.pitch = 0.9;
    
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      if (window.speechSynthesis.pending === false) {
        setIsSpeaking(false);
      }
    };
    
    window.speechSynthesis.speak(utterance);
  }, []);

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
        sentenceBuffer.current = '';
    }
  }, [speak]);

  const stop = useCallback(() => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      sentenceBuffer.current = ''; 
      setIsSpeaking(false);
    }
  }, []);

  return { isSpeaking, speak, processStreamChunk, stop };
};