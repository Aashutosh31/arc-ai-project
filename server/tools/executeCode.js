const { VM } = require('vm2');
const util = require('util');

const MAX_LOG_LENGTH = 8000;
const MAX_CODE_LENGTH = 12000;

/**
 * Format primitive/structured values for console logging captured from the sandbox.
 * BigInt will be converted to a plain string here (no trailing 'n').
 */
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

/**
 * Heuristic detection: determine whether an expression is a pure integer arithmetic
 * expression suitable for BigInt conversion. We require:
 *  - At least one digit
 *  - No letters/identifiers (so skip Math.sqrt(...) etc.)
 *  - No decimal points (skip floats)
 *  - No string/quote characters
 *  - No BigInt literal suffix 'n' present
 *  - Only characters from digits, whitespace, parentheses and allowed operators
 *
 * This intentionally errs on the side of safety: if in doubt, we won't transform.
 */
function isIntegerArithmeticExpression(expr) {
    if (!expr || !/\d/.test(expr)) return false;
    if (expr.includes('n')) return false; // user already used BigInt literal
    if (/[A-Za-z_$]/.test(expr)) return false; // contains identifiers or function calls
    if (expr.includes('.') || /["'`]/.test(expr)) return false; // decimals or strings
    // Only allow digits, whitespace, parentheses and operator chars + - * / % 
    // (double-star '**' is two '*' and thus covered).
    if (!/^[0-9+\-*/%()\s]+$/.test(expr)) return false;

    // Prevent expressions that are just a single digit sequence? We allow that (e.g., return 123456789;)
    return true;
}

/**
 * Convert decimal integer literal tokens in the expression to BigInt("...").
 * Leaves existing BigInt literals (with 'n') untouched because the isIntegerArithmeticExpression
 * check excluded expressions containing 'n'.
 *
 * Examples:
 *  "987654321 * 123456789" -> "BigInt(\"987654321\") * BigInt(\"123456789\")"
 *  "-42" -> "-BigInt(\"42\")"
 */
function transformExprToBigInt(expr) {
    // Replace whole decimal number tokens with BigInt("...").
    // We match decimal sequences not followed by 'n'.
    // Use a replace callback to preserve context.
    return expr.replace(/\b(\d+)\b(?!\s*n)/g, (m, digits) => {
        return `BigInt("${digits}")`;
    });
}

/**
 * Deep convert BigInt values found in arbitrary return values to plain strings.
 * This ensures JSON-serializable or JSON-friendly results and matches requirement (6).
 */
function convertBigIntsToStrings(value, seen = new WeakSet()) {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    if (value === null || value === undefined) return value;
    if (Array.isArray(value)) {
        return value.map((v) => convertBigIntsToStrings(v, seen));
    }
    if (typeof value === 'object') {
        // avoid circular refs
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = convertBigIntsToStrings(v, seen);
        }
        return out;
    }
    return value;
}

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

            // Preprocess: transform integer-only arithmetic expressions following `return ...;`
            // We only transform when the expression is safe according to isIntegerArithmeticExpression.
            // This keeps decimals, function calls, identifiers and BigInt literals untouched.
            let transformedCode = code.replace(/return\s+([^;]+);/g, (full, expr) => {
                const candidate = expr.trim();
                if (isIntegerArithmeticExpression(candidate)) {
                    try {
                        const newExpr = transformExprToBigInt(candidate);
                        return `return ${newExpr};`;
                    } catch (e) {
                        // on any unexpected error, fallback to original
                        return full;
                    }
                }
                return full;
            });

            // Also support the case where the entire code is a single expression without `return`
            // e.g., user supplied "987654321 * 123456789"
            // Detect if the code contains only an expression and no semicolons/newlines that likely indicate statements.
            const singleExprCandidate = transformedCode.trim();
            if (!/;\s*$/.test(singleExprCandidate) && isIntegerArithmeticExpression(singleExprCandidate)) {
                transformedCode = `return ${transformExprToBigInt(singleExprCandidate)};`;
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
                    isFinite,
                    BigInt
                },
                eval: false,
                wasm: false,
                allowAsync: true
            });

            // Wrap in async IIFE so user's async code can use await at top-level
            const wrappedCode = `(async () => {\n${transformedCode}\n})()`;

            const result = await vm.run(wrappedCode);

            // Prepare output text and convert BigInt return values to strings
            const output = logs.join('\n').slice(0, MAX_LOG_LENGTH);
            const hasOutput = output.length > 0;
            const hasReturnValue = result !== undefined;

            const cleanedResult = convertBigIntsToStrings(result);

            return {
                success: true,
                // normalize undefined -> null for clearer downstream handling
                result: cleanedResult === undefined ? null : cleanedResult,
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