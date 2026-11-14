import { describe, expect, it, vi } from 'vitest';
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
    // A trailing number is not the word: `apiKey2` still ends in `key`.
    expect(redactCredentials(`apiKey2=${SHORT}`)).toBe('apiKey2=[redacted]');
    // The words are the singular spellings (and `credentials`): a plural is an ordinary noun, so a
    // message that lists keys or tokens keeps its list.
    expect(redactCredentials(`authTokens=${SHORT}`)).toBe(`authTokens=${SHORT}`);
    expect(redactCredentials(`count_tokens=${SHORT}`)).toBe(`count_tokens=${SHORT}`);
    expect(redactCredentials('Allowed keys: (none).')).toBe('Allowed keys: (none).');
    expect(redactCredentials('expected tokens: 3')).toBe('expected tokens: 3');
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

describe('URL userinfo credentials (#920)', () => {
  it('replaces the password of a connection string and keeps the rest of the URL', () => {
    expect(redactCredentials('postgres://am:shortpw@db:5432/am')).toBe('postgres://am:[redacted]@db:5432/am');
    expect(redactCredentials('http://user:pw@clickhouse:8123')).toBe('http://user:[redacted]@clickhouse:8123');
    expect(redactCredentials('redis://:pw@valkey:6379/0')).toBe('redis://:[redacted]@valkey:6379/0');
    expect(redactCredentials('mongodb+srv://app:pw@cluster.example.net/db?retryWrites=true')).toBe(
      'mongodb+srv://app:[redacted]@cluster.example.net/db?retryWrites=true',
    );
    expect(redactCredentials('nats://nats:pw@nats:4222')).toBe('nats://nats:[redacted]@nats:4222');
    expect(redactCredentials('amqp://guest:pw@rabbit:5672/%2f')).toBe('amqp://guest:[redacted]@rabbit:5672/%2f');
  });

  it('redacts a password that contains percent-escapes, a colon or is very long', () => {
    expect(redactCredentials('postgres://u:p%40ss@db:5432/am')).toBe('postgres://u:[redacted]@db:5432/am');
    expect(redactCredentials('postgres://u:pa%3Ass%2Fword@db/am')).toBe('postgres://u:[redacted]@db/am');
    expect(redactCredentials('postgres://u:pa:ss@db/am')).toBe('postgres://u:[redacted]@db/am');
    // No length limit: a long password is still the password.
    const long = 'p'.repeat(4096);
    expect(redactCredentials(`postgres://u:${long}@db/am`)).toBe('postgres://u:[redacted]@db/am');
  });

  it('leaves a URL without a password alone', () => {
    const untouched = [
      'https://user@host',
      'mailto:a@b.c',
      'https://host/path?x=a:b@c',
      'https://host:8080/path',
      'https://host/path#frag@ment',
      'postgres://db:5432/am',
    ];
    for (const text of untouched) expect(redactCredentials(text), text).toBe(text);
  });

  it('does not redact an e-mail address or a clock time', () => {
    expect(redactCredentials('write to ops@example.com at 12:30')).toBe('write to ops@example.com at 12:30');
  });
});

describe('a structured value under a credential key (#902 round 2)', () => {
  it('consumes the whole balanced array or object', () => {
    expect(redactCredentials('{"apiSecret":["shortpw","morepw"]}')).toBe('{"apiSecret":[redacted]}');
    expect(redactCredentials('{"apiSecret":{"value":"shortpw"}}')).toBe('{"apiSecret":[redacted]}');
    expect(redactCredentials('token=[1, 2, 3]')).toBe('token=[redacted]');
    expect(redactCredentials('token={"a":{"b":{"c":1}}}')).toBe('token=[redacted]');
    // A bracket or an escaped quote inside a string does not end the structure early.
    expect(redactCredentials('token=["a]b", {"c": "d\\"e"}]')).toBe('token=[redacted]');
  });

  it('cuts an unbalanced or too deeply nested structure at the end of its line', () => {
    const deep = `${'['.repeat(12)}shortpw${']'.repeat(12)}`;
    expect(redactCredentials(`apiSecret=${deep}`)).toBe('apiSecret=[redacted]');
    expect(redactCredentials('authToken={"value":"shortpw"\nnext line')).toBe('authToken=[redacted]\nnext line');
    expect(redactCredentials('secret=["unterminated\nnext line')).toBe('secret=[redacted]\nnext line');
  });
});

describe('an Authorization value under a credential key (#902 round 2)', () => {
  it('redacts a short Bearer or Basic value of any length', () => {
    expect(redactCredentials('authToken=Bearer abc')).toBe('authToken=Bearer [redacted]');
    expect(redactCredentials('apiSecret=Basic ab')).toBe('apiSecret=Basic [redacted]');
    expect(redactCredentials('Authorization: bearer x')).toBe('Authorization: bearer [redacted]');
    expect(redactCredentials('token: Bearer a')).toBe('token: Bearer [redacted]');
  });
});

describe('an ordinary field ending in Key keeps its text (#898 round 2)', () => {
  it('does not treat a field name that merely ends in Key as a credential', () => {
    const fields = [
      'entryKey',
      'idempotencyKey',
      'sortKey',
      'primaryKey',
      'partitionKey',
      'cacheKey',
      'dedupeKey',
      'foreignKey',
      'groupKey',
      'storeKey',
      'messageKey',
      'routingKey',
      'keyId',
    ];
    for (const field of fields) {
      expect(redactCredentials(`${field}: step "a" does not exist`), field).toBe(`${field}: step "a" does not exist`);
      expect(redactCredentials(`${field}=ascending`), field).toBe(`${field}=ascending`);
    }
    expect(redactCredentials('Allowed keys: (none).')).toBe('Allowed keys: (none).');
    expect(redactCredentials('publicKey: not a VAPID key')).toBe('publicKey: not a VAPID key');
    expect(redactCredentials('publishableKey: not configured')).toBe('publishableKey: not configured');
  });

  it('still redacts a key qualified by a credential word', () => {
    const keys = [
      'key',
      'api_key',
      'api-key',
      'x-api-key',
      'X-Auth-Key',
      'apiKey',
      'apiKey2',
      'API_KEY',
      'secret_access_key',
      'aws_secret_access_key',
      'private-key',
      'privateKey',
      'signingKey',
      'sessionKey',
      'clientKey',
      'consumer_key',
      'encryptionKey',
      'masterKey',
      'hmacKey',
      'jwtKey',
      'vaultKey',
      'kmsKey',
      'shopifyKey',
      'twilioKey',
      'fcmKey',
      'vapidKey',
      'dataKey',
      'rootKey',
      'adminKey',
      'serviceKey',
      'storageKey',
      'licenseKey',
      'appKey',
      'subscriptionKey',
      'apiKeys',
    ];
    for (const key of keys) {
      expect(redactCredentials(`${key}=abcdefghij`), key).toBe(`${key}=[redacted]`);
      expect(redactCredentials(`{"${key}":"abcdefghij"}`), key).toBe(`{"${key}":[redacted]}`);
    }
  });

  it('leaves the value of an ordinary Key field to every other rule', () => {
    // A long opaque value is still a bare token, wherever it sits.
    const token = 'A1b2C3d4E5f6G7h8I9j0K1l2';
    expect(redactCredentials(`idempotencyKey=${token}`)).toBe('idempotencyKey=[redacted]');
    // An ordinary key does not switch the provider prefix or URL rules off either.
    expect(redactCredentials('entryKey=postgres://u:shortpw@db:5432/am')).toBe('entryKey=postgres://u:[redacted]@db:5432/am');
    expect(redactCredentials('sortKey=shpat_0123456789abcdef')).toBe('sortKey=[redacted]');
  });
});

describe('URL userinfo with an @ in the password (#920 round 2)', () => {
  it('takes the last @ of the authority as the userinfo delimiter', () => {
    expect(redactCredentials('http://u:pa@ss@host')).toBe('http://u:[redacted]@host');
    expect(redactCredentials('postgres://u:p@ss@w0rd@db:5432/am')).toBe('postgres://u:[redacted]@db:5432/am');
  });

  it('handles an IPv6 host, an empty user and several URLs in one string', () => {
    expect(redactCredentials('http://u:pw@[::1]:5432/db')).toBe('http://u:[redacted]@[::1]:5432/db');
    expect(redactCredentials('redis://:pw@valkey:6379/0')).toBe('redis://:[redacted]@valkey:6379/0');
    expect(redactCredentials('a postgres://u:pw@db/x and redis://n:q@cache:6379')).toBe(
      'a postgres://u:[redacted]@db/x and redis://n:[redacted]@cache:6379',
    );
    expect(redactCredentials('http://[::1]:5432/path?x=a:b@c')).toBe('http://[::1]:5432/path?x=a:b@c');
  });
});

describe('a multi-line PEM block (#885 round 2)', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----';

  it('consumes the whole block under a credential key', () => {
    expect(redactCredentials(`password=${pem}`)).toBe('password=[redacted]');
    expect(redactCredentials(`secret: ${pem}\ntrailing`)).toBe('secret: [redacted]\ntrailing');
    // A quoted value keeps the shape redaction has always produced: the value, quotes included,
    // becomes the marker.
    expect(redactCredentials(`{"privateKey":"${pem.replaceAll('\n', '\\n')}"}`)).toBe('{"privateKey":[redacted]}');
  });

  it('redacts an unterminated block to the end of the text', () => {
    // A BEGIN without an END is a private key body: nothing of it may survive (#902 round 5).
    expect(redactCredentials('password=-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n')).toBe('password=[redacted]');
    expect(redactCredentials('secret=-----BEGIN PRIVATE KEY-----\nshortpw\nmore\nand more')).toBe('secret=[redacted]');
  });
});

describe('redaction is idempotent (#902 round 2)', () => {
  const forms = [
    'token=shortpw',
    'authToken: Bearer abc',
    'apiSecret=Basic ab',
    '{"apiSecret":["shortpw","morepw"]}',
    '{"apiSecret":{"value":"shortpw"}}',
    'postgres://u:pw@db/am',
    'http://u:pa@ss@host',
    'X-Auth-Token: abc1234567',
    'https://api.example.com/v1/hook?apiSecret=abc1234567&x=1',
    'Invalid OAuth access token: access_token=probe-secret',
    'password=-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
    'sent with Bearer abcdef1234567890',
    'nothing to redact here',
  ];
  for (const form of forms)
    it(`repeats without changing: ${form.slice(0, 40)}`, () => {
      const once = redactCredentials(form);
      expect(redactCredentials(once)).toBe(once);
      expect(redactCredentials(redactCredentials(once))).toBe(once);
    });

  it('does not add a bracket to a marker it already wrote', () => {
    expect(redactCredentials('token=[redacted]')).toBe('token=[redacted]');
    expect(redactCredentials('{"apiSecret":[redacted]}')).toBe('{"apiSecret":[redacted]}');
    expect(redactCredentials('token: Bearer [redacted]')).toBe('token: Bearer [redacted]');
  });
});

describe('separators, markers and Unicode quotes (#902 round 3)', () => {
  it('recognises => as a separator', () => {
    expect(redactCredentials('key => shortpw')).toBe('key => [redacted]');
    expect(redactCredentials('const token => shortpw')).toBe('const token => [redacted]');
    expect(redactCredentials('apiSecret=>shortpw')).toBe('apiSecret=>[redacted]');
  });

  it('keeps a marker only when the value ends there', () => {
    expect(redactCredentials('token=[redacted]')).toBe('token=[redacted]');
    expect(redactCredentials('{"apiSecret":[redacted]}')).toBe('{"apiSecret":[redacted]}');
    // A value that continues after the marker is redacted as a whole, not left readable.
    expect(redactCredentials('token=[redacted]shortpw')).toBe('token=[redacted]');
    expect(redactCredentials('token=[redacted]"shortpw"')).toBe('token=[redacted]');
  });

  it('recognises paired Unicode quotes', () => {
    expect(redactCredentials('token: “short pw”')).toBe('token: [redacted]');
    expect(redactCredentials('token: ‘short pw’')).toBe('token: [redacted]');
    expect(redactCredentials('{"token":"“short pw”"}')).not.toContain('short');
  });
});

describe('the scanner matches JavaScript whitespace (#902 round 3)', () => {
  it('accepts a Unicode space around the separator', () => {
    expect(redactCredentials('token = shortpw')).toBe('token = [redacted]');
    expect(redactCredentials('token = shortpw')).toBe('token = [redacted]');
    expect(redactCredentials('token= shortpw')).toBe('token= [redacted]');
    expect(redactCredentials('token =shortpw')).toBe('token =[redacted]');
    expect(redactCredentials('apiSecret　= shortpw')).toBe('apiSecret　= [redacted]');
  });

  it('treats every ECMAScript line terminator as the end of a line', () => {
    for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
      const input = `apiSecret={"a":${terminator}shortpw`;
      expect(redactCredentials(input), terminator).toBe(`apiSecret=[redacted]${terminator}shortpw`);
    }
  });
});

describe('the scanner cannot be made to fail (#902 round 3)', () => {
  it('returns the bare marker when the scan itself throws', () => {
    const spy = vi.spyOn(String.prototype, 'replace').mockImplementationOnce(() => {
      throw new Error('injected failure');
    });
    try {
      expect(redactCredentials('token=shortpw')).toBe('[redacted]');
    } finally {
      spy.mockRestore();
    }
  });

  it('scans a text of any length, however large', () => {
    const filler = 'word '.repeat(40_000);
    const out = redactCredentials(`${filler}token=shortpw`);
    expect(out).toContain('token=[redacted]');
    expect(out.length).toBeGreaterThan(filler.length);
  });
});

describe('the pair scan runs before the token passes (#902 round 4)', () => {
  it('keeps a long credential key and its short value apart', () => {
    expect(redactCredentials('X-Organization-Auth-Token: shortpw')).toBe('[redacted]: [redacted]');
    expect(redactCredentials('x-organization-auth-token: shortpw')).toBe('[redacted]: [redacted]');
    expect(redactCredentials('{"X-Organization-Auth-Token":"shortpw"}')).toBe('{"[redacted]":[redacted]}');
    expect(redactCredentials("'X-Organization-Auth-Token': 'shortpw'")).toBe("'[redacted]': [redacted]");
  });

  it('redacts an all-caps programmatic name that ends in a credential word', () => {
    const key = 'Zz9Qw8Er7Ty6Ui5Op4As3Df2Gh1JkAccountSecretKey';
    expect(redactCredentials(`${key.toUpperCase()}: shortpw`)).toBe('[redacted]: [redacted]');
    // A short word that merely ends in the letters is still not a credential.
    expect(redactCredentials('MONKEY=zoo')).toBe('MONKEY=zoo');
    expect(redactCredentials('KEYBOARD=us')).toBe('KEYBOARD=us');
  });

  it('redacts a long key that ends in a credential word, in every form', () => {
    const key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaAuthToken';
    expect(key.length).toBeGreaterThanOrEqual(24);
    expect(redactCredentials(`${key}: shortpw`)).toBe('[redacted]: [redacted]');
    expect(redactCredentials(`{"${key}":"shortpw"}`)).toBe('{"[redacted]":[redacted]}');
  });
});

describe('a quoted value spans lines, as in 0.14.20 (#902 round 5)', () => {
  it('redacts a double-quoted value across a literal newline', () => {
    expect(redactCredentials('password="first\nshortpw"')).toBe('password=[redacted]');
    expect(redactCredentials('apiSecret: "first\nshortpw"\ntrailing')).toBe('apiSecret: [redacted]\ntrailing');
  });

  it('redacts a single-quoted value across a literal newline', () => {
    expect(redactCredentials("password='first\nshortpw'")).toBe('password=[redacted]');
  });

  it('redacts a Unicode-quoted value across a literal newline', () => {
    expect(redactCredentials('password: \u201cfirst\nshortpw\u201d')).toBe('password: [redacted]');
    expect(redactCredentials('password: \u2018first\nshortpw\u2019')).toBe('password: [redacted]');
  });

  it('redacts a pretty-printed JSON object across lines', () => {
    const json = '{\n  "grant_type": "authorization_code",\n  "code": "shortpw"\n}';
    expect(redactCredentials(`apiSecret=${json}`)).toBe('apiSecret=[redacted]');
    expect(redactCredentials(`{"privateKey": ${json}}`)).toBe('{"privateKey": [redacted]}');
  });

  it('still cuts an unclosed quote at the end of its line', () => {
    expect(redactCredentials('password="shortpw\nnext line')).toBe('password=[redacted]\nnext line');
  });
});

describe('a scheme keeps one word and one token, and leaves the rest (#902 round 5)', () => {
  it('keeps a provider explanation after the credential', () => {
    expect(redactCredentials('Authorization: Bearer abcdefgh was rejected by the upstream (HTTP 401)')).toBe(
      'Authorization: Bearer [redacted] was rejected by the upstream (HTTP 401)',
    );
  });

  it('keeps the status of a Basic failure', () => {
    expect(redactCredentials('Authorization: Basic dXNlcjpwYXNz failed: 403 Forbidden')).toBe(
      'Authorization: Basic [redacted] failed: 403 Forbidden',
    );
  });

  it('handles repeated and mixed scheme words', () => {
    expect(redactCredentials('token=Bearer Bearer shortpw')).toBe('token=Bearer [redacted]');
    expect(redactCredentials('token=Bearer Basic shortpw tail')).toBe('token=Bearer [redacted] tail');
  });

  it('leaves a query tail alone', () => {
    expect(redactCredentials('authToken=Bearer abc; retry later')).toBe('authToken=Bearer [redacted]; retry later');
  });

  it('redacts a quoted value after the scheme', () => {
    expect(redactCredentials('Authorization: Bearer "abc def" was rejected')).toBe('Authorization: Bearer [redacted] was rejected');
  });

  it('is idempotent on a value it already redacted', () => {
    const once = redactCredentials('Authorization: Bearer abcdefgh was rejected (HTTP 401)');
    expect(redactCredentials(once)).toBe(once);
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
