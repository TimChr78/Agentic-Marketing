export * from './commands';
export * from './deps';
export * from './evaluate';
export * from './notify';
export * from './rules';

import { alertCommands } from './commands';

/** Everything the server registers: the rule commands and the scheduler evaluator. */
export const alertsCommands = alertCommands;
