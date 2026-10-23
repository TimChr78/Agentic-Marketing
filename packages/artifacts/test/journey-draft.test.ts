import { AppError } from '@agentic-marketing/core';
import { describe, expect, it } from 'vitest';
import { contentWarnings, validateContent } from '../src/index';

const template = `eml_${'a'.repeat(32)}`;

const incomplete = {
  purpose: 'marketing_email',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' } },
    { id: 'mail', kind: 'email', label: 'Welcome', config: { template: '' }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ],
};

const complete = {
  purpose: 'marketing_email',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' }, next: [{ to: 'mail' }] },
    { id: 'mail', kind: 'email', label: 'Welcome', config: { template }, next: [{ to: 'done' }] },
    { id: 'done', kind: 'exit', label: 'Done', config: {} },
  ],
};

describe('journey drafts', () => {
  it('saves an unfinished e-mail step as a draft', () => {
    expect(() => validateContent('journey', incomplete, 'draft')).not.toThrow();
  });

  it('reports the unfinished step as a warning', () => {
    const warnings = contentWarnings('journey', incomplete);
    expect(warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ nodeId: 'mail', path: expect.stringContaining('config.template') })]),
    );
    expect(warnings.find((w) => w.nodeId === 'mail')?.message).toContain('An e-mail template id');
  });

  it('refuses to publish the unfinished step with a readable message', () => {
    let error: unknown;
    try {
      validateContent('journey', incomplete, 'publish');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(AppError);
    const message = (error as AppError).message;
    expect(message).toContain('mail');
    expect(message).toContain('config.template');
    expect(message).toContain('An e-mail template id');
  });

  it('still rejects structural mistakes in a draft', () => {
    const twoTriggers = {
      purpose: 'marketing_email',
      nodes: [
        { id: 'start', kind: 'trigger', label: 'One', config: { event: 'Signed Up' } },
        { id: 'again', kind: 'trigger', label: 'Two', config: { event: 'Signed In' } },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    };
    expect(() => validateContent('journey', twoTriggers, 'draft')).toThrow(AppError);

    const unknownEdge = {
      purpose: 'marketing_email',
      nodes: [
        { id: 'start', kind: 'trigger', label: 'Signed up', config: { event: 'Signed Up' }, next: [{ to: 'ghost' }] },
        { id: 'done', kind: 'exit', label: 'Done', config: {} },
      ],
    };
    expect(() => validateContent('journey', unknownEdge, 'draft')).toThrow(AppError);
  });

  it('publishes a complete journey without warnings', () => {
    expect(() => validateContent('journey', complete, 'draft')).not.toThrow();
    expect(() => validateContent('journey', complete, 'publish')).not.toThrow();
    expect(contentWarnings('journey', complete)).toEqual([]);
  });
});
