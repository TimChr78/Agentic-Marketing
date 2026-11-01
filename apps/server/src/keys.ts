import {
  awsKmsKeyProvider,
  cachedKeyProvider,
  chainKeyProviders,
  type KeyProvider,
  localKeyProvider,
  openbaoKeyProvider,
} from '@agentic-marketing/secrets';
import type { Config } from './config';

/**
 * The key-encryption key from the configured provider. With OpenBao or AWS KMS, MASTER_KEY (and
 * MASTER_KEY_PREVIOUS) stay readable as previous keys, so `cli rotate-keys` moves every data key
 * over; afterwards they can be removed.
 */
/**
 * The same provider built from the environment alone, for operations that must not load the full
 * server configuration (`am backup`, `am restore`). Returns undefined when the provider is not
 * configured; a malformed MASTER_KEY still throws, so a typo is not mistaken for "no key".
 */
export function keyProviderFromEnv(env: NodeJS.ProcessEnv = process.env): KeyProvider | undefined {
  const provider = (env.KEY_PROVIDER?.trim() || 'local') as Config['keys']['provider'];
  const masterKey = env.MASTER_KEY?.trim() || undefined;
  const previous = (env.MASTER_KEY_PREVIOUS ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  const local = masterKey ? localKeyProvider(masterKey, previous) : undefined;
  if (provider === 'local') return local;

  if (provider === 'openbao') {
    const addr = env.OPENBAO_ADDR?.trim();
    if (!addr) return local;
    const remote = openbaoKeyProvider({
      addr,
      token: env.OPENBAO_TOKEN?.trim() || undefined,
      tokenFile: env.OPENBAO_TOKEN_FILE?.trim() || undefined,
      mount: env.OPENBAO_TRANSIT_MOUNT?.trim() || 'transit',
      key: env.OPENBAO_TRANSIT_KEY?.trim() || 'agentic-marketing',
      namespace: env.OPENBAO_NAMESPACE?.trim() || undefined,
    });
    return local ? chainKeyProviders(remote, [local]) : remote;
  }

  const keyId = env.AWS_KMS_KEY_ID?.trim();
  const region = env.AWS_REGION?.trim();
  if (!keyId || !region) return local;
  const remote = awsKmsKeyProvider({
    keyId,
    region,
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? '',
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? '',
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
    endpoint: env.AWS_KMS_ENDPOINT?.trim() || undefined,
  });
  return local ? chainKeyProviders(remote, [local]) : remote;
}

export function keyProviderFor(config: Pick<Config, 'keys' | 'masterKey' | 'previousMasterKeys'>): KeyProvider {
  const local = config.masterKey ? localKeyProvider(config.masterKey, config.previousMasterKeys) : undefined;
  if (config.keys.provider === 'local') {
    if (!local) throw new Error('KEY_PROVIDER=local needs MASTER_KEY');
    return local;
  }
  const remote = config.keys.provider === 'openbao' ? openbaoKeyProvider(config.keys.openbao) : awsKmsKeyProvider(config.keys.awsKms);
  return cachedKeyProvider(local ? chainKeyProviders(remote, [local]) : remote);
}
