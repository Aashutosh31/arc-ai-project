const fs = require('fs');
const path = require('path');

// Single source of truth: shared theme catalog (also consumed by the client
// picker via client/src/theme/themes.js). No duplicated id lists.
function loadCatalog() {
    const catalogPath = path.join(__dirname, '..', '..', 'shared', 'themes.json');
    const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    return catalog;
}

const catalog = loadCatalog();
const themeIds = catalog.themes.map((t) => t.id);
const themeNames = catalog.themes.map((t) => t.name).join(', ');

module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "changeTheme",
            description: `Change the visual UI theme or colors of the application. Available themes: ${themeNames}. Use this when the user asks for a different look, 'Hacker mode', 'Red alert', 'Light mode', a 'Cyberpunk'/'Dracula'/'Nord' style, or to revert to the 'Default theme'.`,
            parameters: {
                type: "object",
                properties: {
                    theme: {
                        type: "string",
                        enum: themeIds,
                        description: "The requested theme."
                    }
                },
                required: ["theme"]
            }
        }
    },

    // Exposed for validation/tests: the canonical id list, read live.
    themeIds,

    // 2. Execution Logic
    execute: async (args) => {
        if (!themeIds.includes(args.theme)) {
            return {
                success: false,
                message: `Unknown theme '${args.theme}'. Available themes: ${themeIds.join(', ')}.`,
            };
        }
        console.log(`[Tool: changeTheme] Requesting client to switch to theme: ${args.theme}`);

        return {
            success: true,
            message: `Successfully changed the system UI theme to ${args.theme} mode.`,
            // 🚀 Tell the React frontend to physically change the CSS!
            clientAction: {
                type: 'CHANGE_THEME',
                theme: args.theme
            }
        };
    }
};
