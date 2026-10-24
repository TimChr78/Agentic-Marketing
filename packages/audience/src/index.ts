export * from './broadcasts';
export * from './consent';
export * from './forms';
export * from './hostedPages';
export * from './import';

import { broadcastCommands } from './broadcasts';
import { hostedPageCommands } from './hostedPages';
import { importProfiles } from './import';

export const audienceCommands = [importProfiles, ...broadcastCommands, ...hostedPageCommands] as const;
export * from './messageEvents';
export * from './retention';
