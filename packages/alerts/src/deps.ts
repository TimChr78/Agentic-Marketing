import type { Db } from '@agentic-marketing/db';
import type { EmailServices } from '@agentic-marketing/email';
import type { EventStore } from '@agentic-marketing/events';
import type { KeyProvider } from '@agentic-marketing/secrets';

// The scheduler and the commands both need the same few services. The directory is structural so
// this package does not depend on auth just to resolve a member's address.

export interface AlertDirectory {
  users(ids: string[]): Promise<Map<string, { email: string; name: string }>>;
}

export interface NotifyDeps {
  kp: KeyProvider;
  email: EmailServices;
  directory: AlertDirectory;
  /** Admin UI base URL for the "open the alert" link. */
  publicUrl: string;
}

export interface AlertDeps extends NotifyDeps {
  db: Db;
  events: EventStore;
}
