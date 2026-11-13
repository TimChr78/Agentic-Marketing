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
    const detail = providerDiagnostic(JSON.stringify({ error: { code: 500, message: 'x'.repeat(2_000) } }), 120);
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(detail.endsWith('…')).toBe(true);
  });
});

describe('redactCredentials', () => {
  it('removes a named credential, an Authorization value and a bare token', () => {
    expect(redactCredentials(`access_token=${SECRET}`)).toBe('access_token=[redacted]');
    expect(redactCredentials('"developer-token": "probe-secret"')).toBe('"developer-token"=[redacted]');
    expect(redactCredentials(`Authorization: Bearer ${SECRET}abcdef`)).toBe('Authorization: Bearer [redacted]');
    expect(redactCredentials('sent with Bearer abcdef1234567890')).toBe('sent with Bearer [redacted]');
    const hex = 'a'.repeat(64);
    expect(redactCredentials(`token ${hex} expired`)).toBe('token [redacted] expired');
  });

  it('leaves a person-readable message alone', () => {
    const message = 'The decision provider answered 422: zero data retention is not available';
    expect(redactCredentials(message)).toBe(message);
    expect(redactCredentials('Mandate mnd_0123456789abcdef0123456789abcdef has no published version to renew.')).toBe(
      'Mandate mnd_0123456789abcdef0123456789abcdef has no published version to renew.',
    );
  });
});
