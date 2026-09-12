'use strict';

// Local fixture MCP server used by the MCP test suite — no external network,
// no dependencies on real integrations.
//
// Tools:
//   get_test_value          → { value: 42, note: 'fixture-ok' }
//   echo                    → { message: `echo: ${input}` }
//   delayed_tool            → sleeps 250ms then succeeds (timeout/cancel tests)
//   large_result            → returns ~40KB of text (output-compaction tests)
//   always_fail             → throws a server-side tool error
//   invalid_args_tool       → REQUIRES `count`; errors when absent/invalid
//   github_create_issue     → mimics issue creation (returns id)
//   get_weather_now         → mimics weather lookup (used for unrelated-intent)
//   late_tool               → registered ~200ms after start + listChanged
//
// Every handler returns an explicit `{ content: [{ type: 'text', text }] }`
// shape — the client-side tool adapter normalizes that for ARC. It is also
// era-agnostic (the v2 SDK flattens plain object returns into result fields,
// which we deliberately avoid for deterministic fixtures).
//
// Runs as:
//   node testMcpServer.js             → stdio transport
//   require('...').createFixtureServer() → McpServer usable with in-memory
//                                          / HTTP factory transports.

const z = require('zod');
const { McpServer } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');

const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });

const LARGE_TEXT = ('The quick brown fox jumps over the lazy dog. ').repeat(300);

const LATE_TOOL_DELAY_MS = 200;

const createFixtureServer = () => {
  const server = new McpServer({
    name: 'arc-test-mcp',
    version: '1.0.0',
    capabilities: { tools: { listChanged: true } }
  });

  server.registerTool(
    'get_test_value',
    { description: 'Return a fixed test value.', inputSchema: z.object({}) },
    async () => text(JSON.stringify({ value: 42, note: 'fixture-ok' }))
  );

  server.registerTool(
    'echo',
    {
      description: 'Echo the provided text back.',
      inputSchema: z.object({ text: z.string(), times: z.number().int().min(1).max(5).optional() })
    },
    async ({ text: input, times }) => text(
      `echo: ${String(input)}`.repeat(times || 1)
    )
  );

  server.registerTool(
    'delayed_tool',
    {
      description: 'Deliberately slow tool; sleeps before resolving.',
      inputSchema: z.object({ delayMs: z.number().int().optional() })
    },
    async ({ delayMs }) => {
      await new Promise((resolve) => setTimeout(resolve, Number.isFinite(delayMs) ? delayMs : 250));
      return text('done=true');
    }
  );

  server.registerTool(
    'large_result',
    { description: 'Returns a very large text result.', inputSchema: z.object({}) },
    async () => text(LARGE_TEXT)
  );

  server.registerTool(
    'always_fail',
    { description: 'Throws a server-side error.', inputSchema: z.object({}) },
    async () => {
      throw new Error('Fixture server exploded on purpose.');
    }
  );

  server.registerTool(
    'invalid_args_tool',
    {
      description: 'Requires a numeric count argument.',
      inputSchema: z.object({ count: z.number().int() })
    },
    async ({ count }) => text(`doubled=${count * 2}`)
  );

  server.registerTool(
    'github_create_issue',
    {
      description: 'Create a GitHub issue for a repository.',
      inputSchema: z.object({
        repository: z.string(),
        title: z.string(),
        body: z.string().optional()
      })
    },
    async ({ repository, title }) => text(JSON.stringify({
      id: `fixture-issue-${Math.floor(Math.random() * 1e6)}`,
      repository,
      title,
      status: 'open'
    }))
  );

  server.registerTool(
    'get_weather_now',
    {
      description: 'Get the current weather for a city.',
      inputSchema: z.object({ city: z.string() })
    },
    async ({ city }) => text(JSON.stringify({ city, temperatureC: 24, condition: 'sunny' }))
  );

  // Dynamic registration + list_changed notification (fires after the client
  // has connected so the notification is received on the live subscription).
  setTimeout(() => {
    try {
      if (!server.isConnected) return;
      server.registerTool(
        'late_tool',
        { description: 'Registered after initial connect.', inputSchema: z.object({}) },
        async () => text(JSON.stringify({ late: true }))
      );
      server.sendToolListChanged();
    } catch {
      // Not yet connected — listChanged is still valid once discovery reruns.
    }
  }, LATE_TOOL_DELAY_MS);

  return server;
};

const main = () => {
  serveStdio(createFixtureServer);
};

if (require.main === module) {
  main();
}

module.exports = { createFixtureServer, LATE_TOOL_DELAY_MS, LARGE_TEXT };