// server/services/TaskExecutor.js (COMPLETE CODE)
const Task = require('../models/Task');
const cron = require('node-cron');

// NOTE: This module executes structured intents (actions) requested by the AI.

// A simple dummy function to "execute" a reminder (free tier compliant)
const mockReminderAlert = (title, userId) => {
    // In this portfolio version, we only log the action.
    // In a real app, this would trigger an email, push notification, or Twilio SMS.
    console.log(`\n🔔 ARC-AI ALERT: Task Alert triggered for User ${userId}: ${title}`);
    console.log(`🔔 Action Executed at: ${new Date().toLocaleTimeString()}`);
    // You could emit a socket event here for real-time dashboard notification
};

const executeTask = async (intent, userId) => {
    const { action, args } = intent;
    let resultMessage = '';

    if (action === 'schedule_reminder') {
        const { title, time } = args;
        if (!title || !time) {
            return "Error: Reminder details incomplete.";
        }

        try {
            // 1. Save to MongoDB
            const task = await Task.create({
                userId,
                actionType: 'REMINDER',
                title: title,
                details: `Scheduled for time: ${time}`,
                scheduledTime: new Date(time)
            });

            // 2. Schedule the job (Placeholder: real date parsing is complex)
            // For a portfolio project, we simply ensure the Task model works.
            
            // Example of scheduling the mock alert to run 5 seconds later for demonstration:
            // NOTE: This simple scheduling will only last until the server restarts.
            setTimeout(() => {
                mockReminderAlert(title, userId);
                // Optionally, mark task as complete in DB here
            }, 5000); // Trigger in 5 seconds for immediate test feedback

            resultMessage = `SUCCESS: Reminder titled "${title}" has been scheduled for future execution.`;

        } catch (error) {
            console.error('Task Scheduling Error:', error);
            resultMessage = `FAILURE: Could not schedule task due to database error.`;
        }

    } else if (action === 'send_message' || action === 'open_app') {
        // Mocking system/external API actions
        console.log(`\n🖥️ ARC-AI MOCK ACTION: Executing ${action} to ${JSON.stringify(args)}`);
        resultMessage = `SUCCESS: Simulated ${action} action. (Free-tier compliant).`;
    } else if (action === 'answer_question' || action === 'get_weather' || action === 'DATA_QUERY') {
        // No execution needed, the AI's text_response handles this.
        resultMessage = `INFO: AI handled conversational query.`;
    } else {
        resultMessage = `ERROR: Task action "${action}" not recognized.`;
    }

    return resultMessage;
};

module.exports = { executeTask };