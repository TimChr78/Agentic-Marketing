import { describe, expect, it } from 'vitest';
import { endpointFailure, endpointOrigin } from '../src/index';

// #951: a non-special scheme (redis, valkey, rediss, nats) has the WHATWG origin "null", but its
// host and port are still parsed. Reporting those as "(invalid URL)" turned a valid VALKEY_URL into
// a wrongly-named configuration error and lost the host that refused the connection. A failure also
// carries its reason one level down (Undici) or inside an AggregateError (a Redis client trying
// several addresses), so the reported code has to be looked up through the nested chain.

describe('endpointOrigin for non-special schemes (#951)', () => {
  it('renders a redis URL as scheme://host:port, without userinfo, path or query', () => {
    expect(endpointOrigin('redis://user:pw@cache.internal:6379')).toBe('redis://cache.internal:6379');
    expect(endpointOrigin('redis://user:pw@cache.internal:6379/2?token=secret')).toBe('redis://cache.internal:6379');
  });

  it.each([
    ['valkey://cache.internal:6379', 'valkey://cache.internal:6379'],
    ['rediss://cache.internal:6380/0', 'rediss://cache.internal:6380'],
    ['nats://nats.internal:4222', 'nats://nats.internal:4222'],
    ['redis://cache.internal', 'redis://cache.internal'],
  ])('keeps the scheme, host and port of %s', (input, expected) => {
    expect(endpointOrigin(input)).toBe(expected);
  });

  it('prefers the scheme the operator configured over a special-scheme origin', () => {
    // The special schemes keep their own origin rule (the default port is elided).
    expect(endpointOrigin('https://user:pw@otel.example:443/v1/traces')).toBe('https://otel.example');
  });

  it('says (invalid URL) when there is no host at all', () => {
    expect(endpointOrigin('cache.internal:6379')).toBe('(invalid URL)');
    expect(endpointOrigin('redis://')).toBe('(invalid URL)');
  });

  it('says (invalid URL) when the value does not parse', () => {
    expect(endpointOrigin('not a url')).toBe('(invalid URL)');
    expect(endpointOrigin('')).toBe('(invalid URL)');
  });
});

describe('endpointFailure reads the nested cause (#951)', () => {
  const endpoint = 'redis://user:pw@cache.internal:6379';

  it('reports the code of an AggregateError member', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), { code: 'ECONNREFUSED' });
    const err = new AggregateError([refused, new Error('all addresses failed')], 'AggregateError');
    expect(endpointFailure(err, endpoint)).toBe('redis://cache.internal:6379 (ECONNREFUSED)');
  });

  it('reports a code buried in a chain of causes', () => {
    const deepest = Object.assign(new Error('connect ETIMEDOUT 10.0.0.5:6379'), { code: 'ETIMEDOUT' });
    const middle = new Error('connect failed', { cause: deepest });
    const err = new Error('PING failed', { cause: middle });
    expect(endpointFailure(err, endpoint)).toBe('redis://cache.internal:6379 (ETIMEDOUT)');
  });

  it('still finds a cause code beside an AggregateError', () => {
    const err = new AggregateError([new Error('nested')], 'AggregateError');
    (err as { cause?: unknown }).cause = Object.assign(new Error('outer'), { code: 'ECONNRESET' });
    expect(endpointFailure(err, endpoint)).toBe('redis://cache.internal:6379 (ECONNRESET)');
  });

  it('falls back to the name when nothing carries a code', () => {
    const err = new AggregateError([new Error('one'), new Error('two')], 'AggregateError');
    expect(endpointFailure(err, endpoint)).toBe('redis://cache.internal:6379 (AggregateError)');
    expect(endpointFailure(new TypeError('boom'), endpoint)).toBe('redis://cache.internal:6379 (TypeError)');
  });

  it('keeps the credential out of the report', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:6379'), { code: 'ECONNREFUSED' });
    expect(endpointFailure(refused, endpoint)).not.toContain('pw');
  });

  it('does not recurse without a bound on a self-referencing cause', () => {
    const err = new Error('loop');
    (err as { cause?: unknown }).cause = err;
    expect(endpointFailure(err, endpoint)).toBe('redis://cache.internal:6379 (Error)');
  });
});
