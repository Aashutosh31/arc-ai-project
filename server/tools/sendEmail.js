const { Resend } = require('resend');

module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "sendEmail",
            description: "Send an email to a specified recipient. Use this when the user asks to email someone, draft a message to someone, or send information via email.",
            parameters: {
                type: "object",
                properties: {
                    recipient: {
                        type: "string",
                        description: "The email address of the person receiving the email."
                    },
                    subject: {
                        type: "string",
                        description: "A concise, professional subject line for the email."
                    },
                    body: {
                        type: "string",
                        description: "The main content/body of the email. Format it nicely."
                    }
                },
                required: ["recipient", "subject", "body"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args) => {
        console.log(`[Tool: sendEmail] Preparing to send HTTP email to: ${args.recipient}`);

        const apiKey = process.env.RESEND_API_KEY;

        // Failsafe: Check if the user forgot to set up their .env variables
        if (!apiKey) {
            console.error("[Tool: sendEmail] Missing RESEND_API_KEY in environment variables.");
            return { 
                success: false, 
                message: "I cannot send emails right now because the Resend API key is not configured." 
            };
        }

        const resend = new Resend(apiKey);

        try {
            // 🚀 Dispatch it via HTTP API (Bypasses SMTP Firewalls!)
            const data = await resend.emails.send({
                // Note: On Resend's free tier, you MUST use this exact 'from' address
                from: 'ARC-AI Assistant <onboarding@resend.dev>', 
                to: args.recipient,
                subject: args.subject,
                html: `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                          ${args.body.replace(/\n/g, '<br>')}
                          <br><br>
                          <hr style="border: none; border-top: 1px solid #eee;" />
                          <small style="color: #888;"><i>This message was sent autonomously by ARC-AI via HTTP API.</i></small>
                       </div>`
            });

            if (data.error) {
                console.error("[Tool: sendEmail] API Error:", data.error);
                throw new Error(data.error.message);
            }

            console.log(`[Tool: sendEmail] Email sent successfully via HTTP! ID: ${data.data.id}`);

            return {
                success: true,
                message: `I have successfully sent the email to ${args.recipient} with the subject "${args.subject}".`
            };

        } catch (error) {
            console.error(`[Tool: sendEmail] Error sending email:`, error);
            return {
                success: false,
                error: `I failed to send the email. API returned an error: ${error.message}`
            };
        }
    }
};