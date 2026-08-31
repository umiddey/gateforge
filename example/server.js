#!/usr/bin/env node
// Entry point for the Gateforge example app. Binds 127.0.0.1 only.
//
// Usage:
//   node server.js             random free port
//   node server.js --port 4173 fixed port
//   node server.js --port=4173

import { parseArgs } from 'node:util';
import { createApp } from './lib/app.js';

const { values } = parseArgs({
  options: { port: { type: 'string' } },
});

let port = 0; // 0 = OS-assigned random free port
if (values.port !== undefined) {
  port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`error: --port must be an integer in [1, 65535], got ${JSON.stringify(values.port)}`);
    process.exit(2); // usage error
  }
}

const server = createApp();
server.listen(port, '127.0.0.1', () => {
  const { address, port: bound } = server.address();
  console.log(`gateforge example app listening on http://${address}:${bound}`);
});

// Graceful shutdown so e2e harnesses can stop the server cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
