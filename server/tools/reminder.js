const Task = require('../models/Task'); 

module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "createReminder",
            description: "Create a reminder or task for the user and save it to the database.",
            parameters: {
                type: "object",
                properties: {
                    taskDescription: {
                        type: "string",
                        description: "The description of the task or reminder to save."
                    }
                },
                required: ["taskDescription"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args, context) => {
        try {
            // context.userId is injected by the TaskExecutor bridge
            const newTask = new Task({
                userId: context.userId,
                description: args.taskDescription,
                status: 'pending'
            });
            
            await newTask.save();
            
            return { 
                success: true, 
                message: `Task successfully saved to database: ${args.taskDescription}` 
            };
        } catch (error) {
            return { 
                success: false, 
                error: `Database error: ${error.message}` 
            };
        }
    }
};