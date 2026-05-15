import { useCallback } from 'react';
import { useChat } from '../contexts/ChatContext'; // 🚀 FIX: Import global context

const sharedSpeechState = {
  sentenceBuffer: '',
  speechQueue: [],
  isQueueRunning: false,
  currentUtterance: null,
  pendingDelay: null,
  activeSpeechSessionId: 0,
  currentSpeechSessionId: 0
};

const cleanTextForSpeech = (text) => {
  let cleaned = String(text || '');

  const replacements = [
    [/\bP\.S\./gi, 'By the way'],
    [/\be\.g\./gi, 'for example'],
    [/\bi\.e\./gi, 'that is'],
    [/\bAI\b/g, 'A I'],
    [/\bNASA\b/g, 'N A S A'],
    [/\bURL\b/gi, 'U R L'],
    [/->/g, ' then '],
    [/&/g, ' and ']
  ];

  cleaned = cleaned.replace(/```[\s\S]*?```/g, ' ');
  cleaned = cleaned.replace(/`([^`]+)`/g, '$1');
  cleaned = cleaned.replace(/\[(.*?)\]\((https?:\/\/[^\s)]+)\)/g, '$1');
  cleaned = cleaned.replace(/https?:\/\/[^\s]+/g, 'a link');
  cleaned = cleaned.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, ' ');
  cleaned = cleaned.replace(/[-*=]{2,}/g, ' ');
  cleaned = cleaned.replace(/[=<-]-+[=>]?|[=<]=+[=>]?/g, ' ');
  cleaned = cleaned.replace(/(^|\s)[-*+]\s/g, ' ');
  cleaned = cleaned.replace(/[#$^_|~<>*]/g, ' ');
  cleaned = cleaned.replace(/\b\d+\.\d+\b/g, (match) => match.replace(/\./g, ' point '));

  for (const [pattern, replacement] of replacements) {
    cleaned = cleaned.replace(pattern, replacement);
  }

  cleaned = cleaned.replace(/[!?]{2,}/g, '!');
  cleaned = cleaned.replace(/\.{3,}/g, '.');
  cleaned = cleaned.replace(/,\s*,+/g, ', ');
  cleaned = cleaned.replace(/\s*([,;:!?\.])\s*/g, '$1 ');
  cleaned = cleaned.replace(/\s{2,}/g, ' ');
  return cleaned.trim();
};

const splitTextForSpeech = (text) => {
  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return [];

  const protectedTokens = [];
  const protectToken = (match) => {
    const tokenId = protectedTokens.push(match) - 1;
    return `__TTS_TOKEN_${tokenId}__`;
  };

  const restoreTokens = (value) => String(value || '').replace(/__TTS_TOKEN_(\d+)__/g, (_, index) => protectedTokens[Number(index)] || '');
  const workingText = cleaned
    .replace(/\bv?\d+(?:\.\d+)+\b/gi, protectToken)
    .replace(/\b\d+\.\d+\b/g, protectToken);

  const sentenceChunks = workingText.split(/(?<=[.!?])\s+(?=[A-Z"“(])/g) || [workingText];
  const segments = [];
  const maxLength = 150;

  const pushWordChunks = (value) => {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    let buffer = '';
    for (const word of words) {
      const candidate = buffer ? `${buffer} ${word}` : word;
      if (candidate.length > maxLength && buffer) {
        segments.push(buffer.trim());
        buffer = word;
      } else {
        buffer = candidate;
      }
    }

    if (buffer.trim()) {
      segments.push(buffer.trim());
    }
  };

  for (const sentence of sentenceChunks) {
    const trimmed = restoreTokens(sentence).trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxLength) {
      segments.push(trimmed);
      continue;
    }

    const clauses = trimmed.split(/(?<=[,;:])\s+/);
    for (const clause of clauses) {
      const clauseText = clause.trim();
      if (!clauseText) continue;

      if (clauseText.length <= maxLength) {
        segments.push(clauseText);
      } else {
        pushWordChunks(clauseText);
      }
    }
  }

  return segments.filter(Boolean);
};

export const useTextToSpeech = () => {
  const { setIsSpeaking } = useChat(); // 🚀 FIX: Use Global State
  const queueDelayMs = 100;

  const startNewSpeechSession = useCallback(() => {
    sharedSpeechState.currentSpeechSessionId += 1;
    sharedSpeechState.activeSpeechSessionId = sharedSpeechState.currentSpeechSessionId;
    return sharedSpeechState.activeSpeechSessionId;
  }, []);

  const invalidateSpeechSession = useCallback(() => {
    sharedSpeechState.currentSpeechSessionId += 1;
    sharedSpeechState.activeSpeechSessionId = 0;
  }, []);

  const finishQueue = useCallback((sessionId) => {
    if (sessionId !== sharedSpeechState.currentSpeechSessionId) return;
    sharedSpeechState.isQueueRunning = false;
    sharedSpeechState.currentUtterance = null;
    sharedSpeechState.speechQueue = [];
    sharedSpeechState.activeSpeechSessionId = 0;
    if (!window.speechSynthesis.pending && !window.speechSynthesis.speaking) {
      setIsSpeaking(false);
    }
  }, [setIsSpeaking]);

  const speakNextInQueue = useCallback((sessionId) => {
    if (sessionId !== sharedSpeechState.currentSpeechSessionId) {
      return;
    }

    if (!('speechSynthesis' in window)) {
      finishQueue(sessionId);
      return;
    }

    const nextItem = sharedSpeechState.speechQueue.shift();
    const nextText = nextItem?.text || '';
    if (!nextText) {
      finishQueue(sessionId);
      return;
    }

    if (sessionId !== sharedSpeechState.currentSpeechSessionId) {
      return;
    }

    const utterance = new SpeechSynthesisUtterance(nextText);
    sharedSpeechState.currentUtterance = utterance;
    utterance.rate = 1.04;
    utterance.pitch = 0.94;
    utterance.volume = 1;

    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => {
      if (sessionId !== sharedSpeechState.currentSpeechSessionId) {
        return;
      }
      sharedSpeechState.currentUtterance = null;
      sharedSpeechState.pendingDelay = setTimeout(() => {
        if (sessionId !== sharedSpeechState.currentSpeechSessionId) {
          return;
        }
        if (sharedSpeechState.speechQueue.length > 0) {
          speakNextInQueue(sessionId);
          return;
        }
        finishQueue(sessionId);
      }, queueDelayMs);
    };
    utterance.onerror = () => {
      if (sessionId !== sharedSpeechState.currentSpeechSessionId) {
        return;
      }
      sharedSpeechState.currentUtterance = null;
      if (sharedSpeechState.speechQueue.length > 0) {
        sharedSpeechState.pendingDelay = setTimeout(() => speakNextInQueue(sessionId), queueDelayMs);
      } else {
        finishQueue(sessionId);
      }
    };

    window.speechSynthesis.speak(utterance);
  }, [finishQueue, setIsSpeaking]);

  const speakQueue = useCallback((segments) => {
    if (!('speechSynthesis' in window)) return;

    const queueItems = Array.isArray(segments) ? segments.map((segment) => String(segment || '').trim()).filter(Boolean) : [];
    if (queueItems.length === 0) return;

    const sessionId = sharedSpeechState.activeSpeechSessionId || startNewSpeechSession();
    sharedSpeechState.speechQueue.push(...queueItems.map((text) => ({ sessionId, text })));
    if (sharedSpeechState.isQueueRunning) return;

    sharedSpeechState.isQueueRunning = true;
    speakNextInQueue(sessionId);
  }, [speakNextInQueue, startNewSpeechSession]);

  const speak = useCallback((text) => {
    const segments = splitTextForSpeech(text);
    speakQueue(segments);
  }, [speakQueue]);

  const processStreamChunk = useCallback((chunk, isFinal) => {
    if (chunk) sharedSpeechState.sentenceBuffer += chunk;

    const shouldFlush = isFinal || /[.!?]/.test(chunk) || sharedSpeechState.sentenceBuffer.length >= 220;
    if (shouldFlush) {
        const sentenceToSpeak = sharedSpeechState.sentenceBuffer;
        if (sentenceToSpeak) speak(sentenceToSpeak);
        sharedSpeechState.sentenceBuffer = '';
    }
  }, [speak]);

  const stopSpeech = useCallback(() => {
    if ('speechSynthesis' in window) {
      if (sharedSpeechState.pendingDelay) {
        clearTimeout(sharedSpeechState.pendingDelay);
        sharedSpeechState.pendingDelay = null;
      }
      invalidateSpeechSession();
      sharedSpeechState.speechQueue = [];
      sharedSpeechState.isQueueRunning = false;
      sharedSpeechState.currentUtterance = null;
      sharedSpeechState.sentenceBuffer = '';
      window.speechSynthesis.cancel();
      setIsSpeaking(false); // Instantly turn off speaking state
    }
  }, [invalidateSpeechSession, setIsSpeaking]);

  const stop = stopSpeech;

  return { speak, processStreamChunk, stop, stopSpeech }; // No longer needs to return isSpeaking
};