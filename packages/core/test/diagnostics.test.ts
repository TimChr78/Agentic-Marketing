import { describe, expect, it } from 'vitest';
import { providerDiagnostic, redactCredentials } from '../src/diagnostics';

// #885: a provider's error body is copied into an AppError whose message reaches the caller, the
// audit log and the agent ledger. Only its own code and message fields may survive, and a token
// the provider (or a gateway in front of it) echoes back must never appear.
const SECRET = 'probe-secret';

describe('providerDiagnostic', () => {
  it('extracts the provider error code and message', () => {
    expect(providerDiagnostic('{"error":{"code":190,"message":"Invalid OAuth access token."}}')).toBe('190: Invalid OAuth access token.');
    expect(providerDiagnostic('{"error":{"code":400,"message":"Request is invalid","status":"INVALID_ARGUMENT"}}')).toBe(
      '400: INVALID_ARGUMENT: Request is invalid',
    );
  });

  it('reads the shapes the platforms actually answer with', () => {
    // TypeSafe / CommandCode decision providers.
    expect(providerDiagnostic('{"detail":"zero data retention is not available"}')).toBe('zero data retention is not available');
    // Shopify GraphQL: a list of messages.
    expect(providerDiagnostic('{"errors":[{"message":"Access denied for customers field"}]}')).toBe('Access denied for customers field');
    // OAuth token endpoints.
    expect(providerDiagnostic('{"error":"invalid_grant","error_description":"The refresh token is expired"}')).toBe(
      'invalid_grant: The refresh token is expired',
    );
  });

  it('never reproduces the raw body', () => {
    // Not JSON (a gateway's HTML page, a plain-text answer): the status is the whole diagnostic.
    expect(providerDiagnostic(`oops access_token=${SECRET}`)).toBe('');
    expect(providerDiagnostic('')).toBe('');
    // JSON without an error field: nothing to say.
    expect(providerDiagnostic('{"data":[]}')).toBe('');
  });

  it('redacts a token the provider echoes in its own message', () => {
    const detail = providerDiagnostic(`{"error":{"code":190,"message":"access_token=${SECRET} was rejected"}}`);
    expect(detail).toContain('190');
    expect(detail).not.toContain(SECRET);
    expect(detail).toContain('access_token=[redacted]');
  });

  it('ignores an echo outside the error fields', () => {
    // A field the diagnostic does not read keeps the token to itself: only code and message are copied.
    const detail = providerDiagnostic(`{"error":{"code":401,"message":"Unauthorized"},"debug":{"access_token":"${SECRET}"}}`);
    expect(detail).toBe('401: Unauthorized');
    expect(detail).not.toContain(SECRET);
  });

  it('bounds the length of a long provider message', () => {
    const detail = providerDiagnostic(JSON.stringify({ error: { code: 500, message: 'long message '.repeat(200) } }), 120);
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('redacts the whole text before truncating it (#885 round 2)', () => {
    const token = 'a'.repeat(64);
    const detail = providerDiagnostic(JSON.stringify({ error: { code: 500, message: `Invalid key ${'.'.repeat(169)}${token}` } }));
    // Truncating first left a short prefix of the token that no rule could recognise.
    expect(detail).not.toContain('aaaaaaaaaa');
    expect(detail.length).toBeLessThanOrEqual(200);
  });
});

describe('redactCredentials', () => {
  it('removes a named credential, an Authorization value and a bare token', () => {
    expect(redactCredentials(`access_token=${SECRET}`)).toBe('access_token=[redacted]');
    expect(redactCredentials('"developer-token": "probe-secret"')).toBe('"developer-token": [redacted]');
    expect(redactCredentials(`Authorization: Bearer ${SECRET}abcdef`)).toBe('Authorization: Bearer [redacted]');
    expect(redactCredentials('sent with Bearer abcdef1234567890')).toBe('sent with Bearer [redacted]');
    const hex = 'a'.repeat(64);
    expect(redactCredentials(`token ${hex} expired`)).toBe('token [redacted] expired');
  });

  it('redacts every credential-shaped key=value, key: value and JSON pair (#885 round 2)', () => {
    const keys = [
      'token',
      'secret',
      'password',
      'passwd',
      'api_key',
      'api-key',
      'key',
      'auth',
      'authorization',
      'credential',
      'signature',
      'client_secret',
      'refresh_token',
      'access_token',
      'developer-token',
      'session',
    ];
    for (const key of keys) {
      expect(redactCredentials(`${key}=${SECRET}`), key).toBe(`${key}=[redacted]`);
      expect(redactCredentials(`${key}: ${SECRET}`), key).toBe(`${key}: [redacted]`);
      expect(redactCredentials(`{"${key}":"${SECRET}"}`), key).not.toContain(SECRET);
      expect(redactCredentials(`"${key}": "${SECRET}"`), key).not.toContain(SECRET);
    }
  });

  it('redacts the token prefixes providers and gateways use (#885 round 2)', () => {
    // Built from pieces so the test file itself carries no committed secret-shaped literal.
    const hex = '0123456789abcdef'.repeat(2);
    const prefixed = (prefix: string) => `${prefix}${hex}`;
    const tokens = [
      prefixed('shpat_'),
      prefixed('shpss_'),
      prefixed('shpca_'),
      prefixed('sk_live_'),
      prefixed('sk_test_'),
      prefixed('rk_'),
      ['xoxb', '0123456789', 'abcdefghijkl'].join('-'),
      ['xoxp', '0123456789', 'abcdefghijkl'].join('-'),
      prefixed('ghp_'),
      prefixed('gho_'),
      prefixed('github_pat_'),
      ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
      ['ya29', hex].join('.'),
      ['eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'signaturepart'].join('.'),
    ];
    for (const token of tokens) {
      expect(redactCredentials(`Invalid token: ${token}`), token).not.toContain(token);
    }
  });

  it('redacts a short opaque run from 24 characters (#885 round 2)', () => {
    const run = 'A1b2C3d4E5f6G7h8I9j0K1l2';
    expect(run).toHaveLength(24);
    expect(redactCredentials(`secret value ${run} was rejected`)).toBe('secret value [redacted] was rejected');
  });

  it('leaves a person-readable message alone', () => {
    const message = 'The decision provider answered 422: zero data retention is not available';
    expect(redactCredentials(message)).toBe(message);
    // Our own external ids are identifiers, not credentials.
    expect(redactCredentials('Mandate mnd_0123456789abcdef0123456789abcdef has no published version to renew.')).toBe(
      'Mandate mnd_0123456789abcdef0123456789abcdef has no published version to renew.',
    );
  });
});
