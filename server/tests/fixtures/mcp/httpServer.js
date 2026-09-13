'use strict';

// Local Streamable HTTP fixture: serves the same fixture server over node:http
// on 127.0.0.1 with an ephemeral port. Prints the port and stays alive until
// SIGTERM/SIGINT.

// Usage: node httpServer.js        (prints port on stdout)
//        require('...').createHttpFixtureServer(cb)  → starts, calls cb(port)

const http = require('node:http');
const { createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler } = require('@modelcontextprotocol/node');
const { createFixtureServer } = require('./testMcpServer');

const createHttpFixtureServer = async (cb) => {
  const handler = createMcpHandler(createFixtureServer);
  const nodeHandler = toNodeHandler(handler);
  const server = http.createServer((req, res) => {
    nodeHandler(req, res).catch((err) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(JSON.stringify({ error: String(err && err.message) }));
    });
  });

  await new Promise((resolve) => {
    server.once('error', (err) => { cb({ error: err }, null); resolve(); });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      cb(null, port);
      resolve();
    });
  });

  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
};

const main = async () => {
  const fixture = await createHttpFixtureServer((err, port) => {
    if (err) {
      console.error('http fixture failed:', err);
      process.exit(1);
    }
    process.stdout.write(`port:${port}\n`);
  });
  process.on('SIGTERM', async () => { await fixture.close(); process.exit(0); });
  process.on('SIGINT', async () => { await fixture.close(); process.exit(0); });
  globalThis.__arcHttpFixture = fixture;
};

if (require.main === module) {
  main();
}

module.exports = { createHttpFixtureServer };