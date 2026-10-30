import { ExternalLink } from 'lucide-react';
import { artifactPath } from '../../app/artifactRoutes';
import { Link } from '../../app/router';
import { Alert, Card, Meta, Mono, StatusPill, Tag } from '../../ui';
import { useArtifactRef } from '../artifactCache';

export interface FormContent {
  purposes?: string[];
  doubleOptIn?: boolean;
  confirmationTemplate?: string;
  consentText?: string;
  traits?: string[];
  successUrl?: string;
  confirmedUrl?: string;
  errorUrl?: string;
  allowedOrigins?: string[];
  turnstile?: boolean;
  hostedPages?: Record<string, unknown>;
}

export function RefName({ id }: { id?: string | null }) {
  const { artifact, error } = useArtifactRef(id);
  if (!id) return <span className="text-muted">None</span>;
  if (error) return <span className="text-bad">{id} (not found)</span>;
  if (!artifact) return <Mono>{id}</Mono>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Link to={artifactPath(artifact.type, artifact.id)} className="font-medium text-accent hover:underline">
        {artifact.name}
      </Link>
      {artifact.publishedVersion ? (
        <StatusPill tone="good">Live v{artifact.publishedVersion}</StatusPill>
      ) : (
        <StatusPill tone="warn">Not published</StatusPill>
      )}
    </span>
  );
}

const url = (u?: string) =>
  u ? (
    <a href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">
      {u} <ExternalLink size={12} aria-hidden />
    </a>
  ) : (
    <span className="text-muted">Not set</span>
  );

/** A signup form as visitors see it, plus what happens on submit (#41). */
export function FormPreview({ content, stacked }: { content: FormContent; stacked?: boolean }) {
  const traits = content.traits ?? ['firstName'];
  return (
    <div className="space-y-4">
      <div className={stacked ? 'grid gap-4' : 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'}>
        <Card title="What visitors see" description="Fields and consent text; the site renders the form itself.">
          <div className="space-y-3 p-4" aria-hidden>
            <div>
              <div className="mb-1 text-[12px] font-medium text-fg-2">E-mail</div>
              <div className="h-8 rounded-md border border-control bg-surface" />
            </div>
            {traits.map((t) => (
              <div key={t}>
                <div className="mb-1 text-[12px] font-medium text-fg-2">{t}</div>
                <div className="h-8 rounded-md border border-control bg-surface" />
              </div>
            ))}
            <div className="flex items-start gap-2">
              <span className="mt-0.5 size-4 shrink-0 rounded-sm border border-control" />
              <p className="text-[13px] whitespace-pre-wrap text-fg">
                {content.consentText || <span className="text-bad">No consent text</span>}
              </p>
            </div>
            <div className="inline-flex h-8 items-center rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg">Subscribe</div>
          </div>
        </Card>
        <Card title="What happens">
          <div className="p-4">
            <Meta
              items={[
                [
                  'Purposes',
                  <span key="purposes" className="flex flex-wrap gap-1">
                    {(content.purposes ?? []).map((p) => (
                      <Tag key={p}>{p}</Tag>
                    ))}
                  </span>,
                ],
                [
                  'Double opt-in',
                  content.doubleOptIn === false ? 'Off: consent counts at once' : 'On: consent counts after the person confirms',
                ],
                ['Confirmation e-mail', <RefName key="confirmation" id={content.confirmationTemplate} />],
                ['After submit', url(content.successUrl)],
                ['After confirming', content.confirmedUrl ? url(content.confirmedUrl) : 'The branded confirmation page'],
                ['On error', url(content.errorUrl)],
                ['Allowed sites', content.allowedOrigins?.length ? content.allowedOrigins.join(', ') : 'Any site'],
                ['Bot check', content.turnstile ? 'Cloudflare Turnstile required' : 'None'],
                ['Hosted pages', content.hostedPages ? 'Overrides the workspace brand' : 'Workspace brand'],
              ]}
            />
          </div>
        </Card>
      </div>
      {content.doubleOptIn !== false && !content.confirmationTemplate && (
        <Alert tone="warn">Double opt-in is on but no confirmation e-mail is set; this form can't be published yet.</Alert>
      )}
    </div>
  );
}
