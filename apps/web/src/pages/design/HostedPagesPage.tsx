import { useState } from 'react';
import { api } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { useApi } from '../../app/useApi';
import { HostedPreview } from '../../features/brand/HostedPreview';
import { Card, Field, Meta, Mono, PageHeader, Select } from '../../ui';
import { pageWidth } from '../../ui/layout';

/** Design → Hosted pages (#37): what subscribers see on your links address, per form. */
export default function HostedPagesPage() {
  useCrumbs([{ label: 'Hosted pages' }]);
  const forms = useApi(() => api.call('artifacts.list', { type: 'form', limit: 200 }), []);
  const archive = useApi(() => api.call('archive.issues', {}), []);
  const archiveSettings = archive.data?.settings;
  const [formId, setFormId] = useState('');
  return (
    <div className={pageWidth('default', 'space-y-5')}>
      <PageHeader
        title="Hosted pages"
        description="The pages subscribers see on your links address after signing up and when they unsubscribe. They use the live brand, and a form can override parts of it."
        actions={
          <ButtonLink to="/design/brand" variant="primary">
            Edit brand
          </ButtonLink>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card padded>
          <HostedPreview formId={formId || undefined} height={600} />
        </Card>
        <div className="space-y-4">
          <Card title="Preview as" padded>
            <Field label="Form" hint="A form's own look (Forms → form → Hosted pages) applies to its confirm and expired pages.">
              <Select value={formId} onChange={(e) => setFormId(e.target.value)}>
                <option value="">Workspace brand</option>
                {forms.data?.artifacts.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
          </Card>
          <Card title="Newsletter archive" padded>
            {archiveSettings?.enabled && archiveSettings.indexUrl ? (
              <>
                <p className="text-[13px] text-fg-2">Sent issues marked “Publish to the archive” appear here, with RSS and a sitemap.</p>
                <p className="mt-2 text-[13px]">
                  <a className="font-medium text-accent hover:underline" href={archiveSettings.indexUrl} target="_blank" rel="noreferrer">
                    Open the live archive
                  </a>
                </p>
                <p className="mt-1 text-[12px] text-muted">
                  <Mono>{archiveSettings.indexUrl}</Mono>
                </p>
              </>
            ) : (
              <>
                <p className="text-[13px] text-fg-2">No public archive yet. Turn it on and choose an address in the brand.</p>
                <p className="mt-2 text-[13px]">
                  <ButtonLink to="/design/brand">Set up the archive</ButtonLink>
                </p>
              </>
            )}
          </Card>
          <Card title="Where they appear" padded>
            <Meta
              items={[
                ['Confirm', <Mono>/f/confirm/…</Mono>],
                ['Unsubscribe', <Mono>/u/…</Mono>],
                ['Web version', <Mono>/n/w/…</Mono>],
                ['Archive', <Mono>{'/n/<slug>/'}</Mono>],
              ]}
            />
            <ul className="mt-3 list-disc space-y-1.5 pl-4 text-[13px] text-fg-2">
              <li>
                Opening a link never confirms or unsubscribes by itself; the person presses the button, so link scanners can't act for them.
              </li>
              <li>Mail clients' one-click unsubscribe (RFC 8058) still works without a page.</li>
              <li>The confirmed page shows after confirming when the form has no confirmed page of its own on your site.</li>
              <li>Expired, confirmed and unsubscribe pages link back to your site.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
