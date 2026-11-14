import { describe, expect, it } from 'vitest';
import { providerDiagnostic, redactCredentials, redactedText, safeErrorText } from '../src/diagnostics';

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
  it('redacts a credential value that merely starts with an auth scheme word (#885 round 3)', () => {
    expect(redactCredentials('token=Bearer-probe-secret')).not.toContain('probe-secret');
    expect(redactCredentials('password=Basicprobe-secret')).not.toContain('probe-secret');
    // A real scheme value is still left to the Authorization rule, which keeps the scheme word.
    expect(redactCredentials('authorization: Bearer abcdef1234567890')).toBe('authorization: Bearer [redacted]');
  });

  it('keeps a provider error code written in capitals and underscores (#885 round 3)', () => {
    expect(redactCredentials('INVALID_AUTHENTICATION_CREDENTIALS')).toBe('INVALID_AUTHENTICATION_CREDENTIALS');
    expect(redactCredentials('code PERMISSION_DENIED_FOR_RESOURCE_TYPE here')).toBe('code PERMISSION_DENIED_FOR_RESOURCE_TYPE here');
  });

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

describe('camelCase and PascalCase credential keys (#898)', () => {
  // Ten characters: below the 24-character bare-token rule, so only the key can identify it.
  const SHORT = 'abc1234567';
  const keys = [
    'authToken',
    'apiSecret',
    'secretKey',
    'signingKey',
    'oauthToken',
    'sessionKey',
    'accessToken',
    'clientSecret',
    'apiKey',
    'privateKey',
    'refreshToken',
    'AuthToken',
    'PASSWORD',
    'signing_key',
    'X-Auth-Token',
    'X-Api-Key',
  ];

  it('redacts the value of a key whose last word is a credential word', () => {
    for (const key of keys) {
      expect(redactCredentials(`${key}: ${SHORT}`), key).toBe(`${key}: [redacted]`);
      expect(redactCredentials(`${key}=${SHORT}`), key).toBe(`${key}=[redacted]`);
    }
  });

  it('redacts the JSON and single-quoted forms', () => {
    for (const key of keys)
      for (const [open, close] of [
        ['"', '"'],
        ["'", "'"],
      ] as const) {
        const text = `{${open}${key}${close}:${open}${SHORT}${close}}`;
        expect(redactCredentials(text), text).not.toContain(SHORT);
        expect(redactCredentials(text), text).toContain('[redacted]');
      }
  });

  it('redacts an HTTP header and a URL query parameter', () => {
    expect(redactCredentials(`X-Auth-Token: ${SHORT}`)).toBe('X-Auth-Token: [redacted]');
    expect(redactCredentials(`https://api.example.com/v1/hook?apiSecret=${SHORT}&x=1`)).toBe(
      'https://api.example.com/v1/hook?apiSecret=[redacted]&x=1',
    );
    expect(redactCredentials(`?sessionKey=${SHORT}`)).toBe('?sessionKey=[redacted]');
  });

  it('redacts only by the last word, not by a word that contains the letters', () => {
    for (const key of ['monkey', 'keyboard', 'keynote', 'hockey', 'author', 'authority', 'tokenizer', 'tokens_count', 'sessions_count'])
      expect(redactCredentials(`${key}=${SHORT}`), key).toBe(`${key}=${SHORT}`);
    // A middle word does not decide: `count` and `sessions` are the last words here.
    expect(redactCredentials(`token_count=${SHORT}`)).toBe(`token_count=${SHORT}`);
    expect(redactCredentials(`tokenCount=${SHORT}`)).toBe(`tokenCount=${SHORT}`);
    // A trailing number is not the word: `apiKey2` still ends in `key`, `authTokens` in `tokens`.
    expect(redactCredentials(`apiKey2=${SHORT}`)).toBe('apiKey2=[redacted]');
    expect(redactCredentials(`authTokens=${SHORT}`)).toBe('authTokens=[redacted]');
    expect(redactCredentials(`count_tokens=${SHORT}`)).toBe('count_tokens=[redacted]');
  });

  it('redacts a credential pair nested in another value', () => {
    // A provider message quoting its own field keeps the field name, which the scan reaches next.
    expect(redactCredentials(`Invalid OAuth access token: access_token=${SHORT}`)).toBe(
      'Invalid OAuth access token: access_token=[redacted]',
    );
    expect(redactCredentials(`hint: url=https://host/x?authToken=${SHORT}&y=1`)).toBe('hint: url=https://host/x?authToken=[redacted]&y=1');
  });

  it('keeps a provider error code and our own ids', () => {
    expect(redactCredentials('INVALID_AUTHENTICATION_CREDENTIALS')).toBe('INVALID_AUTHENTICATION_CREDENTIALS');
    expect(redactCredentials('error INVALID_AUTHENTICATION_CREDENTIALS happened')).toBe(
      'error INVALID_AUTHENTICATION_CREDENTIALS happened',
    );
    expect(redactCredentials(`{"code":"INVALID_AUTHENTICATION_CREDENTIALS","message":"sign-in failed"}`)).toBe(
      '{"code":"INVALID_AUTHENTICATION_CREDENTIALS","message":"sign-in failed"}',
    );
  });
});

describe('safeErrorText (#885 round 5)', () => {
  const token = 'abcdef0123456789'.repeat(3);

  it('redacts the whole text before cutting it to a length', () => {
    const out = safeErrorText(`invalid: ${' '.repeat(51)}${token}`, 80);
    expect(out).not.toContain('abcdef0123456789a');
    expect(out.length).toBeLessThanOrEqual(80);
  });

  it('redacts the whole text before keeping its first line', () => {
    expect(safeErrorText('HTTP 500: password="probe-secret\nrest"', 300)).not.toContain('probe-secret');
  });

  it('keeps an ordinary message, cut to its first line and length', () => {
    expect(safeErrorText('the endpoint timed out\nstack…', 300)).toBe('the endpoint timed out');
    expect(safeErrorText('word '.repeat(100), 9)).toBe('word word');
  });
});

describe('redactedText (#885 round 7)', () => {
  it('redacts before cutting, so a quote past the cut cannot shield a credential', () => {
    const reason = 'x '.repeat(235) + 'password="probe-secret' + ' '.repeat(60) + '"';
    expect(redactedText(reason, 500)).not.toContain('probe-secret');
    expect(redactedText(reason, 500).length).toBeLessThanOrEqual(500);
  });

  it('keeps every line of an ordinary text', () => {
    expect(redactedText('first line\nsecond line', 500)).toBe('first line\nsecond line');
  });
});
