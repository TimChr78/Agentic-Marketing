import { schema, type Tx } from '@agentic-marketing/db';
import { describe, expect, it } from 'vitest';
import { checkSubjectOf } from '../src/checkSubject';

// #278: the independent check must see the SMS and push copy a direct send will render, like it
// already sees an e-mail template's subject and body. These tests use a fake Tx that answers the
// two lookups checkSubjectOf makes: the artifact row, then its published version's content.

const artifact = (type: string, name: string, publishedVersion: number | null) => ({
  id: `${type}_id`,
  workspaceId: 'ws',
  type,
  name,
  publishedVersion,
  latestVersion: 1,
});

function txWith(a: ReturnType<typeof artifact>, content: unknown): Tx {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === schema.artifacts ? [a] : content ? [{ content }] : []),
      }),
    }),
  } as unknown as Tx;
}

describe('the check subject of a direct send (#278)', () => {
  it('shows the SMS template name, purpose and body', async () => {
    const subject = await checkSubjectOf(
      txWith(artifact('sms_template', 'Signal text', 1), { purpose: 'marketing_sms', body: 'Hej {{ profile.firstName }}, news this week' }),
      'ws',
      'messages.sendSms',
      { profileId: 'prf_ada', templateId: 'sms_id' },
    );
    expect(subject).toEqual({
      template: {
        type: 'sms_template',
        name: 'Signal text',
        version: 1,
        purpose: 'marketing_sms',
        body: 'Hej {{ profile.firstName }}, news this week',
      },
    });
  });

  it('shows the push template title, body and link', async () => {
    const subject = await checkSubjectOf(
      txWith(artifact('push_template', 'Signal notification', 1), {
        purpose: 'marketing_push',
        title: 'Hej {{ profile.firstName }}',
        body: 'News this week',
        url: 'https://example.com/news',
      }),
      'ws',
      'messages.sendPush',
      { profileId: 'prf_ada', templateId: 'psh_id' },
    );
    expect(subject).toEqual({
      template: {
        type: 'push_template',
        name: 'Signal notification',
        version: 1,
        purpose: 'marketing_push',
        title: 'Hej {{ profile.firstName }}',
        body: 'News this week',
        url: 'https://example.com/news',
      },
    });
  });

  it('still shows an e-mail template', async () => {
    const subject = await checkSubjectOf(
      txWith(artifact('email_template', 'Issue', 1), {
        purpose: 'marketing_email',
        subject: 'This week',
        mjml: '<mjml />',
        text: 'This week',
      }),
      'ws',
      'messages.sendEmail',
      { profileId: 'prf_ada', templateId: 'eml_id' },
    );
    expect(subject?.template).toMatchObject({ type: 'email_template', subject: 'This week', mjml: '<mjml />' });
  });

  it('shows nothing when the template is unpublished or the wrong kind for the channel', async () => {
    expect(
      await checkSubjectOf(
        txWith(artifact('sms_template', 'Draft', null), { purpose: 'marketing_sms', body: 'Hej' }),
        'ws',
        'messages.sendSms',
        {
          templateId: 'sms_id',
        },
      ),
    ).toBeNull();
    expect(
      await checkSubjectOf(
        txWith(artifact('email_template', 'Issue', 1), { purpose: 'marketing_sms', body: 'Hej' }),
        'ws',
        'messages.sendSms',
        {
          templateId: 'eml_id',
        },
      ),
    ).toBeNull();
  });
});
