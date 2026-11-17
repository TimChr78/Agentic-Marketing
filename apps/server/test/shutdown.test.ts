import { describe, expect, it } from 'vitest';
import { createShutdown, drainWorkers, runShutdownSteps, type ShutdownLog } from '../src/shutdown';

const recorder = () => {
  const infos: string[] = [];
  const errors: Record<string, unknown>[] = [];
  const log: ShutdownLog = {
    info: (message) => infos.push(message),
    error: (fields, message) => errors.push({ ...fields, message }),
  };
  return { log, infos, errors };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('shutdown sequencing (#1014)', () => {
  it('runs every step in order and exits zero when all close', async () => {
    const { log } = recorder();
    const order: string[] = [];
    const code = await runShutdownSteps(
      [
        {
          name: 'http',
          close: () => {
            order.push('http');
          },
        },
        {
          name: 'workers',
          close: () => {
            order.push('workers');
          },
        },
        {
          name: 'database',
          close: async () => {
            order.push('database');
          },
        },
      ],
      log,
    );

    expect(order).toEqual(['http', 'workers', 'database']);
    expect(code).toBe(0);
  });

  it('attempts the later steps after one rejects, logs it and exits non-zero', async () => {
    const { log, errors } = recorder();
    const order: string[] = [];
    const code = await runShutdownSteps(
      [
        {
          name: 'http',
          close: () => {
            order.push('http');
          },
        },
        {
          name: 'events',
          close: async () => {
            throw new Error('events close failed');
          },
        },
        {
          name: 'database',
          close: () => {
            order.push('database');
          },
        },
      ],
      log,
    );

    expect(order).toEqual(['http', 'database']);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ step: 'events', message: 'shutdown step failed' });
  });

  it('does not start a second shutdown for a second signal', async () => {
    const { log } = recorder();
    const started = deferred();
    const release = deferred();
    const exits: number[] = [];
    let runs = 0;
    const controller = createShutdown({
      steps: [
        {
          name: 'workers',
          close: async () => {
            runs += 1;
            started.resolve();
            await release.promise;
          },
        },
      ],
      log,
      exit: (code) => exits.push(code),
    });

    controller.onSignal();
    await started.promise;
    expect(controller.started()).toBe(true);

    controller.onSignal();
    expect(runs).toBe(1);
    expect(exits).toEqual([1]);

    release.resolve();
    await controller.done();
    expect(exits).toEqual([1]);
  });

  it('exits with the failed code when a step rejects', async () => {
    const { log } = recorder();
    const exits: number[] = [];
    const controller = createShutdown({
      steps: [
        {
          name: 'database',
          close: () => Promise.reject(new Error('pool close failed')),
        },
      ],
      log,
      exit: (code) => exits.push(code),
    });

    controller.onSignal();
    await controller.done();
    expect(exits).toEqual([1]);
  });

  it('logs only the step name, never the error text (#1021 review)', async () => {
    const { log, errors } = recorder();
    const code = await runShutdownSteps(
      [
        {
          name: 'database',
          close: async () => {
            throw new Error('connect to postgres://am:hunter2@db/am failed for alice@example.test');
          },
        },
      ],
      log,
    );
    expect(code).toBe(1);
    expect(errors).toEqual([{ step: 'database', message: 'shutdown step failed' }]);
    expect(JSON.stringify(errors)).not.toMatch(/hunter2|alice@example/);
  });

  it('fails the workers step when a worker rejects, after every worker settles (#1021 review)', async () => {
    const { log, errors } = recorder();
    const late = deferred();
    let lateSettled = false;
    const workers = [
      Promise.reject(new Error('worker loop crashed')),
      late.promise.then(() => {
        lateSettled = true;
      }),
    ];
    const run = runShutdownSteps([{ name: 'workers', close: () => drainWorkers(workers) }], log);
    late.resolve();
    expect(await run).toBe(1);
    expect(lateSettled).toBe(true);
    expect(errors).toEqual([{ step: 'workers', message: 'shutdown step failed' }]);
  });

  it('drains cleanly when every worker resolves', async () => {
    await expect(drainWorkers([Promise.resolve(), Promise.resolve(undefined)])).resolves.toBeUndefined();
  });
});
