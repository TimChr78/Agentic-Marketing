import { RefreshCw, Search, Upload, Users } from 'lucide-react';
import { useState } from 'react';
import { api, errText } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { Link, navigate } from '../../app/router';
import { useSession } from '../../app/session';
import { useApi } from '../../app/useApi';
import { ConsentSummary } from '../../features/audience/consent';
import {
  Alert,
  Button,
  EmptyState,
  formatDateTime,
  IconButton,
  Input,
  Mono,
  PageHeader,
  Table,
  TableFrame,
  Tag,
  Td,
  THead,
  Th,
  Tr,
  timeAgo,
  useToast,
} from '../../ui';
import { pageWidth } from '../../ui/layout';

const PROFILE_ID = /^prf_[0-9a-f]{32}$/;

/** People known to the workspace, with the consent they have recorded. */
export default function PeoplePage() {
  useCrumbs([{ label: 'People' }]);
  const { can } = useSession();
  const toast = useToast();
  const pii = can('profiles:pii');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const list = useApi(() => api.call('profiles.list', { limit: 50 }), []);
  const rows = list.data?.profiles ?? [];

  const find = async () => {
    const q = query.trim();
    if (!q) return;
    setSearchError(null);
    // A profile id opens the person directly; e-mail is matched by hash, so it needs no PII.
    if (PROFILE_ID.test(q)) {
      navigate(`/audience/people/${q}`);
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) {
      setSearchError('Enter an e-mail address, or paste a profile id (prf_…).');
      return;
    }
    setSearching(true);
    try {
      const r = await api.call('profiles.find', { type: 'email', value: q });
      if (!r.profileId) {
        setSearchError('No one has that e-mail. They may not have signed up or visited yet.');
        return;
      }
      toast.success(`Found the person behind ${q}.`);
      navigate(`/audience/people/${r.profileId}`);
    } catch (e) {
      setSearchError(errText(e));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="People"
        description="Everyone this workspace has seen, most recent activity first. Search by e-mail without revealing personal data, open a person for their consent and events."
        actions={
          can('profiles:write') && (
            <ButtonLink to="/audience/imports" variant="primary" icon={<Upload size={15} />}>
              Import people
            </ButtonLink>
          )
        }
      />

      {searchError && (
        <Alert tone="bad" className="mb-4">
          {searchError}
        </Alert>
      )}

      <TableFrame
        loading={list.loading}
        error={list.error}
        onRetry={list.reload}
        columns={pii ? 5 : 4}
        isEmpty={rows.length === 0}
        toolbar={
          rows.length > 0 && (
            <>
              <form
                className="flex w-full max-w-[380px] items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void find();
                }}
              >
                <div className="relative min-w-0 flex-1">
                  <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" aria-hidden />
                  <Input
                    compact
                    aria-label="Search by e-mail or profile id"
                    placeholder="E-mail or prf_… profile id"
                    className="pl-8"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </div>
                <Button size="sm" type="submit" loading={searching}>
                  Find
                </Button>
              </form>
              <span className="ml-auto text-[12px] text-muted">{rows.length.toLocaleString()} people</span>
              <IconButton label="Refresh people" icon={<RefreshCw size={14} />} onClick={list.reload} />
            </>
          )
        }
        empty={
          <EmptyState
            icon={<Users size={16} />}
            title="No people yet"
            action={
              <>
                {can('profiles:write') && (
                  <ButtonLink to="/audience/imports" variant="primary" icon={<Upload size={15} />}>
                    Import people
                  </ButtonLink>
                )}
                {can('artifacts:read') && <ButtonLink to="/build/forms">Create a signup form</ButtonLink>}
              </>
            }
          >
            People appear when your site, a form or an integration identifies them. Import an existing subscriber list, or add a signup form
            so new people arrive with their consent.
          </EmptyState>
        }
      >
        <Table label="People">
          <THead>
            <tr>
              <Th>Person</Th>
              {pii && <Th className="hidden md:table-cell">E-mail</Th>}
              <Th className="hidden lg:table-cell">Key traits</Th>
              <Th>Consent</Th>
              <Th>Last seen</Th>
            </tr>
          </THead>
          <tbody>
            {rows.map((p) => {
              const consent = p.consent.filter((c): c is { purpose: string; status: string } => c.status !== null);
              const email = p.email;
              const traits = Object.entries(p.traits).slice(0, 2);
              return (
                <Tr key={p.id} href={`/audience/people/${p.id}`} onClick={() => navigate(`/audience/people/${p.id}`)}>
                  <Td>
                    <Link
                      to={`/audience/people/${p.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-medium text-fg hover:underline"
                    >
                      {email ?? <Mono>{p.id.slice(0, 14)}…</Mono>}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
                      <Mono className="bg-transparent px-0">{p.id.slice(0, 18)}…</Mono>
                      <Tag>{p.known ? 'Known' : 'Anonymous'}</Tag>
                    </div>
                  </Td>
                  {pii && (
                    <Td className="hidden md:table-cell">
                      {email ? <span className="break-all">{email}</span> : <span className="text-muted">Not captured</span>}
                    </Td>
                  )}
                  <Td className="hidden lg:table-cell">
                    {traits.length ? (
                      <span className="line-clamp-2">{traits.map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</span>
                    ) : (
                      <span className="text-muted">No traits</span>
                    )}
                  </Td>
                  <Td>
                    <ConsentSummary consent={consent} />
                  </Td>
                  <Td className="whitespace-nowrap" title={formatDateTime(p.lastSeen)}>
                    {timeAgo(p.lastSeen)}
                  </Td>
                </Tr>
              );
            })}
          </tbody>
        </Table>
      </TableFrame>
    </div>
  );
}
