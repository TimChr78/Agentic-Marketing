export * from './archive';
export * from './broadcasts';
export * from './consent';
export * from './forms';
export * from './hostedPages';
export * from './import';

import { archiveCommands } from './archive';
import { broadcastCommands } from './broadcasts';
import { hostedPageCommands } from './hostedPages';
import { importProfiles } from './import';

export const audienceCommands = [importProfiles, ...broadcastCommands, ...hostedPageCommands, ...archiveCommands] as const;
export * from './messageEvents';
export * from './retention';
