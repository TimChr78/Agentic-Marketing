import { Agent, createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestAborts, requestAbortOf, withRequestAborts } from '../src/http/request-aborts';
import { drainHttpServer, runShutdownSteps, type ShutdownLog, type ShutdownStep } from '../src/shutdown';

// #1059: the http shutdown step stops accepting connections and waits, bounded, for the requests
// already in flight, so the pools and clients close after them rather than underneath them. Idle
// keep-alive sockets are dropped at once; anything still running at the bound is force-closed.

const log: ShutdownLog = { info: () => undefined, error: () => undefined };

let server: Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

function listen(s: Server): Promise<number> {
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve((s.address() as AddressInfo).port)));
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** One real HTTP request; resolves with the body, or rejects if the connection is dropped. */
function get(port: number, agent?: Agent, path = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve(body));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP shutdown drain (#1059)', () => {
  it('waits for an in-flight request, and the pools close after it', async () => {
    const started = deferred();
    const release = deferred();
    let responded = false;
    server = createServer((_req, res) => {
      started.resolve();
      void release.promise.then(() => {
        responded = true;
        res.end('done');
      });
    });
    const port = await listen(server);

    const pending = get(port);
    await started.promise;

    let poolClosed = false;
    let handlerCompletedBeforePoolClose = false;
    const steps: ShutdownStep[] = [
      { name: 'http', close: () => drainHttpServer(server as Server, 5_000) },
      {
        name: 'database',
        close: async () => {
          // The "database" step runs only after the http step resolved.
          poolClosed = true;
          handlerCompletedBeforePoolClose = responded;
        },
      },
    ];
    const shuttingDown = runShutdownSteps(steps, log);

    // Give the drain a turn to run: it must still be waiting on the handler.
    await new Promise((r) => setImmediate(r));
    expect(poolClosed).toBe(false);

    release.resolve();
    await expect(pending).resolves.toBe('done');
    await shuttingDown;

    expect(handlerCompletedBeforePoolClose).toBe(true);
    expect(poolClosed).toBe(true);
  });

  it('closes an idle keep-alive socket without waiting for the bound', async () => {
    server = createServer((_req, res) => res.end('ok'));
    const port = await listen(server);
    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    await expect(get(port, agent)).resolves.toBe('ok');
    const force = vi.spyOn(server, 'closeAllConnections');
    // A bound this small would expire long before a kept-alive client gave up.
    await drainHttpServer(server as Server, 50);

    expect(force).not.toHaveBeenCalled();
    agent.destroy();
  });

  it('force-closes what is still running at the bound', async () => {
    const started = deferred();
    server = createServer(() => {
      // Never answers: only the bound can end the wait.
      started.resolve();
    });
    const port = await listen(server);
    const pending = get(port);
    pending.catch(() => undefined);
    // The request is connected and its handler is running before the drain starts.
    await started.promise;

    const force = vi.spyOn(server, 'closeAllConnections');
    await drainHttpServer(server as Server, 50);

    expect(force).toHaveBeenCalled();
    expect(server.listening).toBe(false);
  });
});

describe('HTTP shutdown aborts what it force-closes (#1098)', () => {
  it('aborts a turn that outlives the bound, and its cleanup finishes before the pools close', async () => {
    const aborts = createRequestAborts();
    const started = deferred();
    let aborted = false;
    let cleanupDone = false;
    // A copilot-like route: the handler returns a stream whose producer keeps working after it
    // returned, so only the request's own signal can stop it when the drain gives up.
    const app = new Hono();
    app.use('*', withRequestAborts(aborts));
    app.get('/turn', (c) => {
      // The handler returns before its stream ends, so it takes its own hold.
      const request = requestAbortOf(c)?.retain();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          started.resolve();
          try {
            await new Promise<void>((resolve) => {
              const signal = request?.signal;
              if (!signal || signal.aborted) return resolve();
              signal.addEventListener('abort', () => resolve(), { once: true });
            });
            aborted = request?.signal.aborted ?? false;
            // The turn's finally store: it must run before the shutdown closes the pools.
            cleanupDone = true;
          } finally {
            request?.release();
          }
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/plain' } });
    });
    server = createServer(getRequestListener(app.fetch));
    const port = await listen(server);
    const pending = get(port, undefined, '/turn');
    pending.catch(() => undefined);
    await started.promise;

    let cleanupBeforePoolClose = false;
    const steps: ShutdownStep[] = [
      { name: 'http', close: () => drainHttpServer(server as Server, 50, { aborts, settleMs: 5_000 }) },
      {
        name: 'database',
        close: () => {
          cleanupBeforePoolClose = aborted && cleanupDone;
        },
      },
    ];
    await runShutdownSteps(steps, log);

    expect(aborted).toBe(true);
    expect(cleanupDone).toBe(true);
    expect(cleanupBeforePoolClose).toBe(true);
    expect(server.listening).toBe(false);
  });

  it('aborts every registered request and settles once they release', async () => {
    const aborts = createRequestAborts();
    const request = aborts.begin();
    const retained = request.retain();
    // The middleware's own hold ends when the handler returns; the turn keeps the request alive.
    request.release();
    expect(aborts.count()).toBe(1);

    aborts.abortAll();
    expect(request.signal.aborted).toBe(true);
    expect(retained.signal.aborted).toBe(true);
    let settled: boolean | undefined;
    const settling = aborts.settle(60_000).then((value) => (settled = value));
    await Promise.resolve();
    expect(settled).toBeUndefined();

    retained.release();
    await settling;
    expect(settled).toBe(true);
    expect(aborts.count()).toBe(0);
    // A request that already ended never holds a drain.
    await expect(aborts.settle(60_000)).resolves.toBe(true);
  });
});
