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
                    recipient: { type: "string", description: "The email address of the person receiving the email." },
                    subject: { type: "string", description: "A concise, professional subject line for the email." },
                    body: { type: "string", description: "The main content/body of the email. Format it nicely." }
                },
                required: ["recipient", "subject", "body"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args) => {
        console.log(`[Tool: sendEmail] Routing email via Google Serverless Webhook to: ${args.recipient}`);

        const webhookUrl = process.env.GOOGLE_EMAIL_WEBHOOK;

        if (!webhookUrl) {
            console.error("[Tool: sendEmail] Missing GOOGLE_EMAIL_WEBHOOK in .env file.");
            return { success: false, message: "Serverless webhook URL is missing from environment variables." };
        }

        try {
            const htmlContent = `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                    ${args.body.replace(/\n/g, '<br>')}
                    <br><br>
                    <hr style="border: none; border-top: 1px solid #eee;" />
                    <small style="color: #888;"><i>This message was sent autonomously by ARC-AI via Serverless Webhook.</i></small>
                </div>
            `;

            // 🚀 The Production Bypass: HTTP POST to Google's Infrastructure (Port 443)
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    to: args.recipient,
                    subject: args.subject,
                    html: htmlContent
                })
            });

            const resultText = await response.text();
            
            let result;
            try {
                result = JSON.parse(resultText);
            } catch (e) {
                 throw new Error("Invalid response from Google Serverless Webhook.");
            }

            if (!result.success) {
                throw new Error(result.error || "Unknown webhook error");
            }

            console.log(`[Tool: sendEmail] Email delivered successfully via Microservice!`);

            return {
                success: true,
                message: `I have successfully sent the email to ${args.recipient} with the subject "${args.subject}".`
            };

        } catch (error) {
            console.error(`[Tool: sendEmail] Microservice Error:`, error);
            return {
                success: false,
                error: `I failed to send the email. API returned an error: ${error.message}`
            };
        }
    }
};