import { createServer, type Server } from 'node:http';
import type { Captain, Log } from './loop.ts';
import type { StateStore } from './state.ts';

/**
 * The Sprite's URL routes to port 8080, and a request to it wakes a sleeping
 * Sprite. So waking Captain is just a POST to /wake: the hub's cron (or the
 * owner, or a test) calls it, and Captain runs one tick.
 *
 * /wake takes no input and returns nothing sensitive, so it needs no secret:
 * the worst a stranger can do is make Captain check the hub early. It is
 * debounced so a burst of requests is one tick.
 */
export function startServer(opts: { port: number; agentId: string; captain: Captain; state: StateStore; pollMinutes: number; log: Log }): Server {
  const { captain, state, log } = opts;
  let pending: Promise<unknown> | null = null;
  let lastWake = 0;

  const runTick = (why: string) => {
    if (pending) return;
    pending = captain
      .tick()
      .then((r) => log(`tick (${why}): ${r.action} ${r.detail}`))
      .catch((err: unknown) => log(`tick (${why}) failed: ${(err as Error).message}`))
      .finally(() => {
        pending = null;
      });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      const s = state.read();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: opts.agentId, working: s.active?.taskTitle ?? null, waiting: s.waiting.length, lastTickAt: s.lastTickAt }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/wake') {
      req.resume(); // drain and ignore any body
      const now = Date.now();
      if (now - lastWake > 5_000) {
        lastWake = now;
        runTick('wake');
      }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  server.listen(opts.port, '0.0.0.0', () => log(`listening on :${opts.port} (POST /wake, GET /health)`));
  const poll = setInterval(() => runTick('poll'), opts.pollMinutes * 60_000);
  server.on('close', () => clearInterval(poll));
  runTick('start');
  return server;
}
