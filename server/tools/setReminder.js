const cron = require('node-cron');

module.exports = {
    schema: {
        type: "function",
        function: {
            name: "setReminder",
            description: "Schedule a proactive background reminder or recurring alarm for the user. Convert the user's requested time into a valid cron expression.",
            parameters: {
                type: "object",
                properties: {
                    reminderText: { 
                        type: "string", 
                        description: "The exact message to speak to the user when the reminder triggers." 
                    },
                    cronExpression: { 
                        type: "string", 
                        description: "A valid standard cron expression (e.g., '* * * * *' for every minute, '0 * * * *' for every hour)." 
                    }
                },
                required: ["reminderText", "cronExpression"]
            }
        }
    },
    
    execute: async (args, passedUserId) => {
        let uid = typeof passedUserId === 'object' && passedUserId !== null 
            ? (passedUserId.userId || passedUserId.id || passedUserId._id) : passedUserId;
        uid = String(uid);

        console.log(`[Tool: setReminder] Scheduling Cron for user ${uid}: ${args.cronExpression} -> "${args.reminderText}"`);
        
        try {
            if (!cron.validate(args.cronExpression)) {
                return { success: false, message: "Invalid cron expression generated." };
            }

            if (!global.userCronJobs.has(uid)) {
                global.userCronJobs.set(uid, []);
            }
            if (global.userCronJobs.get(uid).length >= 5) {
                return { success: false, message: "You already have 5 active reminders. Please cancel them before setting a new one." };
            }

            const task = cron.schedule(args.cronExpression, () => {
                console.log(`[Cron Triggered] Executing reminder for exact user: ${uid}`);
                
                // 🚀 THE FIX: Fetch the Set of all active tabs
                const userSockets = global.connectedSockets?.get(uid);
                
                if (userSockets && userSockets.size > 0) {
                    console.log(`[Cron Success] Broadcasting reminder to ${userSockets.size} active tab(s)!`);
                    // Blast the reminder to every open window!
                    userSockets.forEach(liveSocket => {
                        liveSocket.emit('ai:client:action', {
                            type: 'TRIGGER_REMINDER',
                            message: args.reminderText
                        });
                    });
                } else {
                    console.log(`[Cron Failed] Could not find any active browser tabs for user ${uid}.`);
                }
            });

            global.userCronJobs.get(uid).push(task);

            return { 
                success: true, 
                message: `I have successfully scheduled the reminder: "${args.reminderText}" to run on pattern [${args.cronExpression}].` 
            };
        } catch (error) {
            console.error(`[Tool: setReminder] Error:`, error);
            return { success: false, error: "Failed to schedule the reminder." };
        }
    }
};