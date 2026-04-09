module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "stopReminder",
            description: "Stop, clear, or cancel active background reminders and alarms for the user. Use this when the user says 'stop the reminder', 'cancel my alarms', or 'turn off the timer'.",
            parameters: {
                type: "object",
                properties: {}, // No parameters needed, we'll just clear all of them for now to be safe
                required: []
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args, passedUserId) => {
        let uid = typeof passedUserId === 'object' && passedUserId !== null 
            ? (passedUserId.userId || passedUserId.id || passedUserId._id) : passedUserId;
        uid = String(uid);

        console.log(`[Tool: stopReminder] User ${uid} requested to cancel all active reminders.`);
        
        try {
            // Find the user's active jobs in memory
            const activeJobs = global.userCronJobs?.get(uid) || [];

            if (activeJobs.length === 0) {
                return { success: true, message: "You don't have any active reminders running right now." };
            }

            // 🚀 THE KILL SWITCH: Loop through every active task and run the .stop() command
            activeJobs.forEach(task => task.stop());

            // Clear the array in memory
            global.userCronJobs.set(uid, []);

            console.log(`[Tool: stopReminder] Successfully killed ${activeJobs.length} jobs for ${uid}.`);

            return { 
                success: true, 
                message: `I have successfully cancelled and stopped all your active reminders.` 
            };
        } catch (error) {
            console.error(`[Tool: stopReminder] Error:`, error);
            return { success: false, error: "Failed to stop the reminders." };
        }
    }
};