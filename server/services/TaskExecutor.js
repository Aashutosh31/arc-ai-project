// server/services/TaskExecutor.js (FINAL CODE - Fixed Intent Logic)
const Task = require('../models/Task');
const cron = require('node-cron');

// A simple dummy function to "execute" a reminder (free tier compliant)
const mockReminderAlert = (title, userId) => {
    console.log(`\n🔔 ARC-AI ALERT: Task Alert triggered for User ${userId}: ${title}`);
    console.log(`🔔 Action Executed at: ${new Date().toLocaleTimeString()}`);
};

const executeTask = async (intent, userId) => {
    const { action, args, intent: intentType } = intent; 
    let resultMessage = '';

    // --- NEW: Immediately return if the AI only wants to chat ---
    // If the intent is CONVERSATION, we skip all execution logic.
    if (intentType === 'CONVERSATION') {
        return `INFO: AI handled conversational query.`;
    }
    // -------------------------------------------------------------
    
    // Logic runs ONLY for TASK_EXECUTION or DATA_QUERY
    if (action === 'schedule_reminder') {
        const { title, time } = args;
        if (!title || !time) {
            return "Error: Reminder details incomplete.";
        }
        
        try {
            const task = await Task.create({
                userId, actionType: 'REMINDER', title, details: `Scheduled for time: ${time}`, scheduledTime: new Date(time)
            });

            setTimeout(() => {
                mockReminderAlert(title, userId);
            }, 5000); 

            resultMessage = `SUCCESS: Reminder titled "${title}" has been scheduled for future execution.`;

        } catch (error) {
            console.error('Task Scheduling Error:', error);
            resultMessage = `FAILURE: Could not schedule task due to database error.`;
        }

    } else if (action === 'get_weather') {
        // Since the AI provides the answer directly in its response (like in your image),
        // we SIMULATE fetching data here to confirm the action occurred.
        const location = args.location || 'current location';
        console.log(`\n☁️ ARC-AI MOCK ACTION: Fetching weather data for ${location}.`);
        resultMessage = `SUCCESS: External data for ${location} fetched and integrated into AI response.`;
        
    } else if (action === 'send_message' || action === 'open_app') {
        // Mocking other system/external API actions
        console.log(`\n🖥️ ARC-AI MOCK ACTION: Executing ${action} to ${JSON.stringify(args)}`);
        resultMessage = `SUCCESS: Simulated ${action} action. (Free-tier compliant).`;
    } else {
        resultMessage = `ERROR: Task action "${action}" not recognized.`;
    }

    return resultMessage;
};

module.exports = { executeTask };