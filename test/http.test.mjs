import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let child;
let port;
let baseUrl;

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port: selected } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return selected;
}

before(async () => {
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(root, 'build/http.js')], {
    cwd: root,
    env: {
      ...process.env,
      GARMIN_EMAIL: 'test@example.invalid',
      GARMIN_PASSWORD: 'test-only-password',
      MCP_HTTP_HOST: '127.0.0.1',
      MCP_HTTP_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let lastError = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { lastError += chunk; });
  child.stdout.setEncoding('utf8').on('data', () => {});
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error(`HTTP server exited: ${lastError}`);
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  child.kill('SIGTERM');
  throw new Error(`HTTP server failed to start: ${lastError}`);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('health check does not expose MCP data', async () => {
  const response = await fetch(`${baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('client can initialize and list tools over Streamable HTTP without application credentials', async () => {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const init = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'http-test', version: '0.0.1' },
      },
    }),
  });
  const initBody = await init.text();
  assert.equal(init.status, 200, initBody);
  const sessionId = init.headers.get('mcp-session-id');
  assert.ok(sessionId, 'server should issue a session ID');

  const listed = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  });
  const listBody = await listed.text();
  assert.equal(listed.status, 200, listBody);
  const payload = JSON.parse(listBody);
  assert.ok(payload.result.tools.length >= 40, 'expected Garmin MCP tools');
});
