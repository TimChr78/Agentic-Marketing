import { describe, expect, it } from 'vitest';
import { filterRestoreFenceEntries } from '../src/ops/restore-toc';

// The lines below are real `pg_restore --list` output for a database that has
// `public.restore_fence`, a table with the same name in another schema, a table whose name merely
// starts with it, and a serial table (whose sequence entries do not name their table).

const HEADER = `;
; Archive created at 2026-11-27 11:17:35 CET
;     dbname: toc_probe
;     TOC Entries: 18
;
; Selected TOC Entries:
;`;

const FENCE_LINES = [
  '215; 1259 18765636 TABLE public restore_fence am',
  '3463; 0 0 COMMENT public TABLE restore_fence am',
  '3464; 0 0 COMMENT public COLUMN restore_fence.backup am',
  '3465; 0 0 ACL public TABLE restore_fence am',
  '3305; 2604 18765649 DEFAULT public restore_fence id am',
  '3302; 2606 18765643 CONSTRAINT public restore_fence restore_fence_pkey am',
  // A constraint name with a space keeps the entry the fence's own: the table token is still the
  // fence, and the rest is the constraint's name.
  '3303; 2606 18765644 CONSTRAINT public restore_fence restore_fence pkey am',
  '3481; 0 0 COMMENT public CONSTRAINT restore_fence_pkey ON restore_fence am',
  '3446; 0 18765636 TABLE DATA public restore_fence am',
];

const OTHER_LINES = [
  // Same table name, another schema: a different table.
  '219; 1259 18765655 TABLE other restore_fence am',
  '3468; 0 18765655 TABLE DATA other restore_fence am',
  // Another table in public whose name starts with the fence's.
  '220; 1259 18765660 TABLE public restore_fence_extra am',
  '3469; 0 18765660 TABLE DATA public restore_fence_extra am',
  '217; 1259 18765645 SEQUENCE public restore_fence_seq_id_seq am',
  '3480; 0 0 SEQUENCE SET public restore_fence_seq_id_seq am',
  '3479; 0 0 SEQUENCE OWNED BY public restore_fence_seq_id_seq am',
  '3319; 2606 18765653 CONSTRAINT public restore_fence_seq restore_fence_seq_pkey am',
];

const toc = (...groups: string[][]) => `${[HEADER, ...groups.flat()].join('\n')}\n`;

describe('the archive table of contents a restore loads', () => {
  it('removes every entry that belongs to public.restore_fence', () => {
    const filtered = filterRestoreFenceEntries(toc(FENCE_LINES, OTHER_LINES));
    for (const line of FENCE_LINES) expect(filtered).not.toContain(line);
    expect(filtered).toBe(toc(OTHER_LINES));
  });

  it('keeps the archive header and every other entry byte for byte', () => {
    expect(filterRestoreFenceEntries(toc(OTHER_LINES))).toBe(toc(OTHER_LINES));
  });

  it('keeps an entry whose description is not one this filter understands', () => {
    // A newer pg_restore could add a description. Leaving it in can only keep the load as it was;
    // dropping a line it cannot read risks removing an object that has nothing to do with the fence.
    const unknown = '9999; 9999 9999 SOMETHING NEW public restore_fence am';
    expect(filterRestoreFenceEntries(toc([unknown], OTHER_LINES))).toBe(toc([unknown], OTHER_LINES));
  });

  it('does not match a table whose name is only part of another field', () => {
    const misleading = [
      '9998; 1259 1 TABLE public other am',
      '9997; 0 0 ACL public TABLE other restore_fence am',
      '9996; 1259 2 TABLE public restore_fence_copy am',
    ];
    expect(filterRestoreFenceEntries(toc(misleading))).toBe(toc(misleading));
  });

  it('splits the fields by position, so a space in a schema or table name is not the fence', () => {
    // pg_restore prints the namespace and the tag unquoted, so a space that belongs to either one
    // is indistinguishable from the separator. Splitting by position keeps that space as its own
    // (empty) field, where a scheme that collapses spaces would read these as `public.restore_fence`.
    const nearMisses = [
      // A schema named `public ` with the fence's table name, or a table named ` restore_fence`:
      // both print exactly like this.
      '218; 1259 18765636 TABLE public  restore_fence am',
      '223; 1259 18765660 TABLE public  restore_fence am',
      // A table named `restore_fence `.
      '219; 1259 18765640 TABLE public restore_fence  am',
      // A different table whose name starts with the fence's. Its trigger, FK, constraint and
      // comment are named after that table, not after the fence.
      '220; 1259 18765642 TABLE public restore_fence legacy am',
      '3336; 2620 18765644 TRIGGER public restore_fence legacy trig on legacy am',
      '3335; 2606 18765646 FK CONSTRAINT public restore_fence legacy legacy fk am',
      '3337; 2606 18765648 CONSTRAINT public restore_fence legacy restore_fence legacy_pkey am',
      '3497; 0 0 COMMENT public TABLE "restore_fence legacy" am',
      // A constraint on the table named `restore_fence `.
      '3331; 2606 18765650 CONSTRAINT public restore_fence  pk sp am',
      // A comment on a table in the schema named `public `.
      '3508; 0 0 COMMENT public  TABLE restore_fence am',
    ];
    expect(filterRestoreFenceEntries(toc(nearMisses))).toBe(toc(nearMisses));
  });
});
