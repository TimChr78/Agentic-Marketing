import { describe, expect, it } from 'vitest';
import { isMcpResourceUrlAllowed } from '../src';

describe('isMcpResourceUrlAllowed', () => {
  it.each([
    'https://marketing.example.com',
    'https://192.168.1.20:3210',
    'http://localhost:3000',
    'http://127.0.0.1:3210',
    'http://127.9.9.9',
    'http://[::1]:3210',
    'http://app.localhost:3000',
  ])('allows %s', (url) => {
    expect(isMcpResourceUrlAllowed(url)).toBe(true);
  });

  it.each([
    'http://192.168.1.20:3210',
    'http://am.lan:3000',
    'http://marketing.example.com',
    'ftp://marketing.example.com',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isMcpResourceUrlAllowed(url)).toBe(false);
  });
});
