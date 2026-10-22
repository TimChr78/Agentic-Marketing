import { uuidv7 } from 'uuidv7';

/** Time-ordered UUID (v7): index friendly, sortable by creation time. */
export const newUuid = (): string => uuidv7();

/** External id with a type prefix, e.g. `jrn_0192f3c2b4…`. Prefixes make ids self-describing for people and agents. */
export const newId = (prefix: string): string => `${prefix}_${uuidv7().replaceAll('-', '')}`;

export const ID_PATTERN = /^[a-z]{2,5}_[0-9a-f]{32}$/;
