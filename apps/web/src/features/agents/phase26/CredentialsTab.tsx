import { useState } from 'react';
import { Link } from '../../../app/router';
import { Alert, Card, EmptyState, Tag } from '../../../ui';
import { Identifier } from '../../../ui/Identifier';
import { HostedAgentCard } from '../HostedAgentCard';
import { type Agent, CREDENTIAL_KIND } from '../labels';
import { type AgentDetail, safeDateText } from './model';

// The Credentials tab (#509): the credentials already in agents.get, with their kind, since and a
// copy control. No secret value and no invented last-used time. The hosted agent and its runs are
// a separate lane mounted only when expanded, so the first tab open reads nothing extra.

export function CredentialsTab({ agent, canArtifacts, onChanged }: { agent: AgentDetail; canArtifacts: boolean; onChanged: () => void }) {
  if (!canArtifacts) {
    return (
      <Alert tone="info" title="Restricted by your role">
        Credentials need artifact access. No protected reads were made. Ask a workspace administrator for access.
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <Card
        title="Credentials"
        description="Each credential acts as this agent. Pausing or revoking the agent stops all of them at once. Secret values are never returned here."
      >
        {agent.credentials.length === 0 ? (
          <EmptyState compact title="No credentials">
            This agent has no API token, MCP client or hosted credential. It may have been revoked.{' '}
            <Link to="/settings/integrations" className="text-accent hover:underline">
              Open Integrations
            </Link>{' '}
            to create one.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {agent.credentials.map((credential) => (
              <li key={`${credential.kind}:${credential.id}`} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <Tag>{CREDENTIAL_KIND[credential.kind] ?? credential.kind}</Tag>
                <Identifier value={credential.id} label={`${CREDENTIAL_KIND[credential.kind] ?? credential.kind} ID`} />
                <span className="ml-auto text-[12px] whitespace-nowrap text-muted">since {safeDateText(credential.since)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-line px-4 py-3 text-[12px] leading-[18px] text-muted">
          Secret values are never shown. Last used is not recorded by this read, so it stays Unavailable.
        </p>
      </Card>

      <LazyHosted agent={agent} onChanged={onChanged} />
    </div>
  );
}

/**
 * The old hosted-agent card, mounted only when the disclosure opens. Its own reads (hosted runs,
 * memory, skill names) and its Run now / Edit / Delete controls therefore start on expansion, not
 * when the Credentials tab opens.
 */
function LazyHosted({ agent, onChanged }: { agent: Agent; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-lg border border-line bg-surface" aria-label="Hosted agent">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className="flex min-h-10 cursor-pointer items-center px-4 py-3 text-[13px] font-medium text-accent">
          Show the hosted agent and its runs
        </summary>
        {open && (
          <div className="space-y-4 border-t border-line p-4">
            <HostedAgentCard agentId={agent.id} onChanged={onChanged} />
          </div>
        )}
      </details>
    </section>
  );
}
