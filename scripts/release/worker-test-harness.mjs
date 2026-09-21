import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Execute the actual dry-run bundle in workerd, with no external HTTP access. */
export async function createWorkerHarness(t, testUrl, runtime, bindings, handle) {
  const { Miniflare, convertV4MiniflareOptions, Log, LogLevel, Response } = runtime;
  const config = readFileSync(new URL('../wrangler.toml', testUrl), 'utf8');
  const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([\d-]+)"/m)?.[1];
  assert.ok(compatibilityDate, 'Use the Worker configuration compatibility date');
  const calls = [];
  const errors = [];
  const observers = new Set();
  const completed = new Set();
  const pending = new Set();
  const options = convertV4MiniflareOptions({
    name: 'bundle-smoke',
    modules: true,
    // Pass exact bundle bytes. Miniflare's file-path loader and source-map
    // handling are not part of the Worker contract under test.
    script: readFileSync(new URL('../dist/index.js', testUrl), 'utf8'),
    compatibilityDate,
    host: '127.0.0.1',
    port: 0,
    cf: false,
    bindings,
    log: new Log(LogLevel.NONE),
    outboundService: (request) => {
      const task = (async () => {
        const call = {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body: await request.text(),
        };
        calls.push(call);
        try {
          return await handle(call);
        } catch (error) {
          // Worker error handling must not hide a failed test assertion or an
          // unexpected destination. There is deliberately no network fallback.
          errors.push(error);
          return new Response('Unexpected test upstream request', { status: 599 });
        } finally {
          completed.add(call);
          for (const observer of observers) observer(call);
        }
      })();
      pending.add(task);
      return task.finally(() => pending.delete(task));
    },
  });
  const mf = new Miniflare({ ...options, telemetry: { enabled: false } });
  t.after(async () => {
    let timer;
    try {
      // dispose() does not await Node-side outbound handlers. Drain them first
      // so a delayed assertion cannot become a false green after teardown.
      await Promise.race([
        (async () => { while (pending.size) await Promise.all([...pending]); })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Mock upstream did not finish within 5 seconds')), 5000);
        }),
      ]);
    } catch (error) {
      errors.push(error);
    } finally {
      clearTimeout(timer);
      await mf.dispose();
    }
    if (errors.length) throw new AggregateError(errors, 'Mock upstream contract failed');
  });
  await mf.ready;
  return {
    mf,
    calls,
    waitForCall(predicate) {
      const existing = calls.find((call) => completed.has(call) && predicate(call));
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const finish = (call) => {
          if (!predicate(call)) return;
          clearTimeout(timer);
          observers.delete(finish);
          resolve(call);
        };
        const timer = setTimeout(() => {
          observers.delete(finish);
          reject(new Error('Expected upstream call was not observed within 5 seconds'));
        }, 5000);
        observers.add(finish);
      });
    },
  };
}
