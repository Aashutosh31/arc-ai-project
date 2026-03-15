const fs = require('fs');
const path = require('path');

const tools = {};

/**
 * Recursively scans the tools directory to auto-load all available plugins.
 * This makes it incredibly easy for open-source contributors to add tools.
 */
const loadTools = (dir) => {
    // Prevent crashing if the tools directory is empty or missing subdirectories
    if (!fs.existsSync(dir)) return;

    const files = fs.readdirSync(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        
        // Recursively search subdirectories (e.g., system/, tasks/, web/)
        if (fs.statSync(fullPath).isDirectory()) {
            loadTools(fullPath);
        } else if (file.endsWith('.js') && file !== 'index.js') {
            try {
                const tool = require(fullPath);
                // Validate that the tool follows our strict contract
                if (tool.schema && tool.schema.function && tool.schema.function.name && tool.execute) {
                    tools[tool.schema.function.name] = tool;
                    console.log(`[Tool Registry] Loaded plugin: ${tool.schema.function.name}`);
                }
            } catch (error) {
                console.error(`[Tool Registry] Failed to load tool at ${fullPath}:`, error.message);
            }
        }
    }
};

// Initialize the registry by scanning the current directory
loadTools(__dirname);

// Export the schemas specifically formatted for Mistral's API
const getSchemas = () => {
    return Object.values(tools).map(t => t.schema);
};

// Export tool fetcher for the TaskExecutor
const getTool = (name) => {
    return tools[name];
};

module.exports = {
    getSchemas,
    getTool,
    tools
};