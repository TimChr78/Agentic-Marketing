import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clickHouseStore, migrateClickHouse, resetClickHouse } from '../src/clickhouse';

// #931 review round 3 (A1): the ClickHouse client authenticates from the URL userinfo itself. A
// credential-bearing URL is moved to the client's username/password options, which must produce
// exactly the same outgoing Basic header as before (never the client's `default:` fallback).

const requests: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = [];
let server: Server;
let base = '';
const expected = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
      // A ClickHouse HTTP endpoint: ping answers text, every other request is an empty success
      // (the migrations read an empty JSONEachRow result and issue their DDL/inserts).
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Ok.\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(raw.includes('SELECT name, checksum') ? '' : '');
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server?.close());

const last = () => requests.at(-1)!;
const host = () => new URL(base).host;

describe('ClickHouse URL credentials (#931 A1)', () => {
  it('sends the percent-decoded URL userinfo as Basic on the runtime client', async () => {
    requests.length = 0;
    await clickHouseStore({ url: `http://alice:p%40ss@${host()}`, database: 'am' }).ping();
    expect(last().headers.authorization).toBe(expected('alice', 'p@ss'));
    expect(last().headers.host).toBe(host());
  });

  it('keeps the client default when the URL has no credentials', async () => {
    requests.length = 0;
    await clickHouseStore({ url: base, database: 'am' }).ping();
    expect(last().headers.authorization).toBe(expected('default', ''));
  });

  it('uses the URL credentials for the migrations path', async () => {
    requests.length = 0;
    await migrateClickHouse(`http://alice:p%40ss@${host()}`, 'am');
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.headers.authorization).toBe(expected('alice', 'p@ss'));
  });

  it('uses the URL credentials for resetClickHouse', async () => {
    requests.length = 0;
    await resetClickHouse(`http://alice:p%40ss@${host()}`, 'am');
    expect(last().headers.authorization).toBe(expected('alice', 'p@ss'));
  });

  it('keeps URL userinfo ahead of a query-string http_header_authorization', async () => {
    requests.length = 0;
    const url = `http://alice:p%40ss@${host()}?http_header_authorization=${encodeURIComponent('Bearer from-url')}`;
    await clickHouseStore({ url, database: 'am' }).ping();
    expect(last().headers.authorization).toBe(expected('alice', 'p@ss'));
  });
});
