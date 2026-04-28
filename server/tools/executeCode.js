const { VM } = require('vm2');
const util = require('util');

const MAX_LOG_LENGTH = 8000;
const MAX_CODE_LENGTH = 12000;

const formatValue = (value) => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }

    if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
    }

    return util.inspect(value, {
        depth: 4,
        breakLength: 120,
        maxArrayLength: 50,
        compact: true
    });
};

const createSandboxConsole = (logs) => {
    const push = (level, args) => {
        const line = `[${level}] ${args.map(formatValue).join(' ')}`.trim();
        if (!line) return;
        logs.push(line.slice(0, MAX_LOG_LENGTH));
    };

    return {
        log: (...args) => push('log', args),
        info: (...args) => push('info', args),
        warn: (...args) => push('warn', args),
        error: (...args) => push('error', args),
        debug: (...args) => push('debug', args)
    };
};

module.exports = {
    schema: {
        type: 'function',
        function: {
            name: 'executeCode',
            description: 'Run a small, self-contained JavaScript snippet inside a hardened sandbox to compute exact math/logic answers or test deterministic code. Use this when reasoning is better done by execution than by guessing.',
            parameters: {
                type: 'object',
                properties: {
                    code: {
                        type: 'string',
                        description: 'Raw JavaScript code to execute. Write the final answer with `return` or `console.log` the result. The sandbox supports async code.'
                    }
                },
                required: ['code']
            }
        }
    },

    execute: async (args) => {
        try {
            const code = typeof args?.code === 'string' ? args.code.trim() : '';

            if (!code) {
                return { success: false, error: 'No code was provided to executeCode.' };
            }

            if (code.length > MAX_CODE_LENGTH) {
                return { success: false, error: `Code exceeds the ${MAX_CODE_LENGTH} character limit.` };
            }

            const logs = [];
            const vm = new VM({
                timeout: 1200,
                sandbox: {
                    console: createSandboxConsole(logs),
                    Math,
                    Number,
                    String,
                    Boolean,
                    Array,
                    Object,
                    JSON,
                    Date,
                    RegExp,
                    Set,
                    Map,
                    Promise,
                    parseInt,
                    parseFloat,
                    isNaN,
                    isFinite
                },
                eval: false,
                wasm: false,
                allowAsync: true
            });

            const wrappedCode = `(async () => {\n${code}\n})()`;
            const result = await vm.run(wrappedCode);

            const output = logs.join('\n').slice(0, MAX_LOG_LENGTH);
            const hasOutput = output.length > 0;
            const hasReturnValue = result !== undefined;

            return {
                success: true,
                result: result === undefined ? null : result,
                output,
                logs,
                message: hasOutput && hasReturnValue
                    ? 'Code executed successfully with console output and a return value.'
                    : hasOutput
                        ? 'Code executed successfully with console output.'
                        : hasReturnValue
                            ? 'Code executed successfully with a return value.'
                            : 'Code executed successfully.'
            };
        } catch (error) {
            return {
                success: false,
                error: error?.message || 'Sandbox execution failed.',
                errorType: error?.name || 'Error'
            };
        }
    }
};