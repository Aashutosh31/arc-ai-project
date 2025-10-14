// client/src/contexts/ChatContext.js (CORRECTED CODE)
import React, { createContext, useContext, useState } from 'react';

const ChatContext = createContext(null); // Use null as default value for safety

export const useChat = () => {
    const context = useContext(ChatContext);
    if (context === undefined) {
        // This helpful message appears if the hook is used outside the provider
        throw new Error('useChat must be used within a ChatProvider');
    }
    return context;
};

export const ChatProvider = ({ children }) => {
    const [history, setHistory] = useState([]);

    const addMessage = (role, content) => {
        setHistory(prev => [...prev, { role, content, timestamp: new Date() }]);
    };

    // --- CRITICAL: Ensure all desired values are passed in the value prop ---
    const contextValue = { history, addMessage, setHistory }; 

    return (
        <ChatContext.Provider value={contextValue}>
            {children}
        </ChatContext.Provider>
    );
};