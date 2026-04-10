const cheerio = require('cheerio');

module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "scrapeWebsite",
            description: "Fetch and read the text content of a live website or article. Use this when the user asks you to summarize a link, read an article, or look up information at a specific URL.",
            parameters: {
                type: "object",
                properties: {
                    url: { 
                        type: "string", 
                        description: "The full, valid URL of the website to scrape (e.g., https://en.wikipedia.org/wiki/SpaceX)." 
                    }
                },
                required: ["url"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args) => {
        console.log(`[Tool: scrapeWebsite] Fetching live data from: ${args.url}`);
        
        try {
            // 🚀 Fetch the website (Using a fake User-Agent so websites don't block us as a bot!)
            const response = await fetch(args.url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (!response.ok) {
                return { success: false, message: `Failed to access website. HTTP Status: ${response.status}` };
            }

            const html = await response.text();

            // 🚀 Load HTML into Cheerio
            const $ = cheerio.load(html);

            // 🧹 Clean up the junk! Remove scripts, styles, ads, navbars, and footers
            $('script, style, noscript, iframe, img, svg, header, footer, nav, aside').remove();

            // Extract the pure text and clean up extra spacing
            let rawText = $('body').text().replace(/\s+/g, ' ').trim();

            if (!rawText) {
                return { success: false, message: "Could not extract readable text from this page. It might be a JavaScript-heavy web app." };
            }

            // 🛑 SAFETY GUARD: Mistral has a memory limit. We'll truncate to ~40,000 characters.
            if (rawText.length > 40000) {
                rawText = rawText.substring(0, 40000) + "\n...[Content truncated for length]";
            }

            console.log(`[Tool: scrapeWebsite] Successfully scraped ${rawText.length} characters.`);

            return { 
                success: true, 
                content: rawText,
                message: "Successfully scraped the website. Analyze the 'content' provided and answer the user's request."
            };

        } catch (error) {
            console.error(`[Tool: scrapeWebsite] Error:`, error);
            return { success: false, error: `Failed to scrape the website: ${error.message}` };
        }
    }
};