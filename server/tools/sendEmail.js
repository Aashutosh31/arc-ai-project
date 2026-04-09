const nodemailer = require('nodemailer');
const dns = require('dns');

// 🚀 THE RENDER MAGIC BULLET: Force Node.js to use IPv4 instead of IPv6!
// This prevents the silent ETIMEDOUT drops on cloud platforms.
dns.setDefaultResultOrder('ipv4first');

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
        console.log(`[Tool: sendEmail] Preparing to send email to: ${args.recipient}`);

        const user = process.env.EMAIL_USER;
        const pass = process.env.EMAIL_PASS;

        // Failsafe: Check if the user forgot to set up their .env variables
        if (!user || !pass) {
            console.error("[Tool: sendEmail] Missing EMAIL_USER or EMAIL_PASS in .env file.");
            return { 
                success: false, 
                message: "I cannot send emails right now because the email credentials are not configured in the server's environment variables." 
            };
        }

        try {
           // 🚀 The Bulletproof Cloud SMTP Configuration
            const transporter = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 587,         // Use 587 instead of 465 for better cloud routing
                secure: false,     // Must be false for 587 (it upgrades via STARTTLS)
                requireTLS: true,  // Force it to upgrade to secure connection
                auth: {
                    user: user,
                    pass: pass
                },
                tls: {
                    rejectUnauthorized: false 
                }
            });

            // 🚀 Package the email
            const mailOptions = {
                from: `"ARC-AI Assistant" <${user}>`,
                to: args.recipient,
                subject: args.subject,
                text: args.body,
                html: `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                          ${args.body.replace(/\n/g, '<br>')}
                          <br><br>
                          <hr style="border: none; border-top: 1px solid #eee;" />
                          <small style="color: #888;"><i>This message was sent autonomously by ARC-AI on behalf of Aashutosh.</i></small>
                       </div>` 
            };

            // 🚀 Dispatch it!
            const info = await transporter.sendMail(mailOptions);
            console.log(`[Tool: sendEmail] Email sent successfully! Message ID: ${info.messageId}`);

            return {
                success: true,
                message: `I have successfully sent the email to ${args.recipient} with the subject "${args.subject}".`
            };

        } catch (error) {
            console.error(`[Tool: sendEmail] Error sending email:`, error);
            return {
                success: false,
                error: `I failed to send the email. Please check the backend console for SMTP or authentication errors.`
            };
        }
    }
};