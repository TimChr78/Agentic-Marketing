import { describe, expect, it } from 'vitest';
import { addAudienceMembers, importAudienceCsv, removeAudienceMembers } from '../src/audiences';

// #1247: the three command descriptions offered "a static or snapshot segment", but every handler
// refuses a snapshot before doing anything (`requireList`). An agent that follows the description
// was told to do something the command cannot do.

describe('audience membership descriptions name only what is accepted (#1247)', () => {
  for (const cmd of [addAudienceMembers, removeAudienceMembers, importAudienceCsv]) {
    it(`${cmd.name} does not offer a snapshot segment`, () => {
      expect(cmd.description).not.toContain('snapshot segment');
      expect(cmd.description).toContain('static segment');
      // The refused case points at the command that does change a snapshot.
      expect(cmd.description).toContain('audiences.refreshSnapshot');
    });
  }
});
