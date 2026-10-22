export * from './broadcasts';
export * from './consent';
export * from './forms';
export * from './import';

import { broadcastCommands } from './broadcasts';
import { importProfiles } from './import';

export const audienceCommands = [importProfiles, ...broadcastCommands] as const;
export * from './messageEvents';
export * from './retention';
