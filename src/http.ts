import { timingSafeEqual, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server';

const host = process.env.MCP_HTTP_HOST ?? '0.0.0.0';
const port = Number(process.env.MCP_HTTP_PORT ?? 3000);
const authToken = process.env.MCP_AUTH_TOKEN;
const allowedHosts = process.env.MCP_ALLOWED_HOSTS?.split(',').map((value) => value.trim()).filter(Boolean);

if (!process.env.GARMIN_EMAIL || !process.env.GARMIN_PASSWORD) {
  throw new Error('GARMIN_EMAIL and GARMIN_PASSWORD are required');
}
if (!authToken || authToken.length < 32) {
  throw new Error('MCP_AUTH_TOKEN is required and must be at least 32 characters');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('MCP_HTTP_PORT must be a valid TCP port');
}

type McpSession = {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
};
const sessions = new Map<string, McpSession>();
const maxSessions = 16;
const sessionIdleTimeoutMs = 30 * 60 * 1000;
const sessionReaper = setInterval(() => {
  const cutoff = Date.now() - sessionIdleTimeoutMs;
  for (const [id, session] of sessions) {
    if (session.lastUsedAt < cutoff) void session.transport.close();
  }
}, 60_000);
sessionReaper.unref();

function hasValidBearerToken(header: string | undefined): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(authToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function authorize(req: Request, res: Response, next: () => void): void {
  if (!hasValidBearerToken(req.header('authorization'))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

function getSession(req: Request, res: Response): McpSession | undefined {
  const id = req.header('mcp-session-id');
  if (!id) {
    res.status(400).json({ error: 'mcp-session-id is required' });
    return undefined;
  }
  const session = sessions.get(id);
  if (!session) res.status(404).json({ error: 'unknown MCP session' });
  return session;
}

const app = createMcpExpressApp({ host, allowedHosts });
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));
app.use('/mcp', authorize);

app.post('/mcp', async (req, res) => {
  const sessionId = req.header('mcp-session-id');
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (session) session.lastUsedAt = Date.now();

  if (!session) {
    if (sessionId) {
      res.status(404).json({ error: 'unknown MCP session' });
      return;
    }
    if (req.body?.method !== 'initialize') {
      res.status(400).json({ error: 'first MCP request must initialize a session' });
      return;
    }
    if (sessions.size >= maxSessions) {
      res.status(503).json({ error: 'MCP session capacity reached' });
      return;
    }

    const server = createMcpServer();
    const sessionKey = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionKey,
      enableJsonResponse: true,
      onsessioninitialized: (id) => sessions.set(id, { server, transport, lastUsedAt: Date.now() }),
      onsessionclosed: async (id) => {
        const current = sessions.get(id);
        sessions.delete(id);
        if (current) await current.server.close();
      },
    });
    session = { server, transport, lastUsedAt: Date.now() };
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
      void server.close();
    };

    try {
      await server.connect(transport);
    } catch (error) {
      console.error('Error initializing MCP session:', error);
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      res.status(500).json({ error: 'failed to initialize MCP session' });
      return;
    }
  }

  try {
    await session.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP HTTP request:', error);
    if (!res.headersSent) res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/mcp', authorize, async (req, res) => {
  const session = getSession(req, res);
  if (session) await session.transport.handleRequest(req, res);
});

app.delete('/mcp', authorize, async (req, res) => {
  const session = getSession(req, res);
  if (session) await session.transport.handleRequest(req, res);
});

app.listen(port, host, () => {
  console.log(`Garmin Connect MCP Streamable HTTP server listening on ${host}:${port}`);
});
