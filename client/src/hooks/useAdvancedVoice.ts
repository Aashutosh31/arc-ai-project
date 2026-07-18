import { useState, useEffect, useRef } from 'react';
import { useChat } from '../contexts/ChatContext';

export const useAdvancedVoice = (onFinalCommand?: (text: string) => void, onInterrupt?: () => void) => {
  const [isVoiceModeActive, setIsVoiceModeActive] = useState<boolean>(false);
  const [liveTranscript, setLiveTranscript] = useState('');
  const { setIsVoiceListening } = useChat();
  
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSpeakingRef = useRef<boolean>(false);
  const isVoiceModeActiveRef = useRef<boolean>(false);
  const onFinalCommandRef = useRef(onFinalCommand);
  const onInterruptRef = useRef(onInterrupt);

  useEffect(() => {
    onFinalCommandRef.current = onFinalCommand;
  }, [onFinalCommand]);

  useEffect(() => {
    onInterruptRef.current = onInterrupt;
  }, [onInterrupt]);

  useEffect(() => {
    isVoiceModeActiveRef.current = isVoiceModeActive;
  }, [isVoiceModeActive]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error("Advanced Voice Mode is not supported in this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
      console.log("[Advanced Voice] Listening...");
      setIsVoiceListening(true);
    };

    recognition.onspeechstart = () => {
      isSpeakingRef.current = true;
      if (onInterruptRef.current) onInterruptRef.current();
    };

    recognition.onspeechend = () => {
      isSpeakingRef.current = false;
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalTranscript += event.results[i][0].transcript;
        } else {
          interimTranscript += event.results[i][0].transcript;
        }
      }

      const currentText = (finalTranscript + interimTranscript).trim();
      setLiveTranscript(currentText);

      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      
      if (currentText.length > 0) {
        silenceTimerRef.current = setTimeout(() => {
          console.log("[Advanced Voice] Silence detected. Submitting:", currentText);
          if (onFinalCommandRef.current) {
            onFinalCommandRef.current(currentText);
          }
          setLiveTranscript('');
        }, 1500);
      }
    };

    recognition.onend = () => {
      setIsVoiceListening(false);
      if (isVoiceModeActiveRef.current) {
        try {
          recognition.start();
        } catch (error) {
          console.debug('[Advanced Voice] restart failed', error);
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionEvent) => {
      if (event.error !== 'no-speech') {
        console.error('[Advanced Voice] Recognition error:', event.error);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      recognition.stop();
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
      }
      setIsVoiceListening(false);
    };
  }, []);

  const toggleAdvancedVoice = () => {
    if (isVoiceModeActive) {
      setIsVoiceModeActive(false);
      isVoiceModeActiveRef.current = false;
      try {
        recognitionRef.current?.stop();
      } catch (error) {
        console.debug('[Advanced Voice] stop failed', error);
      }
      setLiveTranscript('');
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
      setIsVoiceListening(false);
    } else {
      setIsVoiceModeActive(true);
      isVoiceModeActiveRef.current = true;
      try {
        recognitionRef.current?.start();
      } catch (e) {
        console.error('[Advanced Voice] Failed to start recognition:', e);
      }
    }
  };

  return { isVoiceModeActive, liveTranscript, toggleAdvancedVoice };
};