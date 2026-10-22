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
export function keyProviderFor(config: Pick<Config, 'keys' | 'masterKey' | 'previousMasterKeys'>): KeyProvider {
  const local = config.masterKey ? localKeyProvider(config.masterKey, config.previousMasterKeys) : undefined;
  if (config.keys.provider === 'local') {
    if (!local) throw new Error('KEY_PROVIDER=local needs MASTER_KEY');
    return local;
  }
  const remote = config.keys.provider === 'openbao' ? openbaoKeyProvider(config.keys.openbao) : awsKmsKeyProvider(config.keys.awsKms);
  return cachedKeyProvider(local ? chainKeyProviders(remote, [local]) : remote);
}
