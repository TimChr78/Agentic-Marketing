import { api } from '../../app/api';
import { useApi } from '../../app/useApi';
import { ArtifactListPage } from '../../features/artifacts/ArtifactListPage';
import { Field, Select } from '../../ui';

type Mode = 'dynamic' | 'static' | 'snapshot';
type CreateState = { mode: Mode; source: string };

export default function SegmentsPage() {
  return (
    <ArtifactListPage<CreateState>
      type="segment"
      title="Segments"
      description="Groups of people by traits, events and consent. Broadcasts, journeys and experiences target them. A static list is imported or curated; a snapshot freezes another segment."
      emptyTitle="No segments yet"
      emptyText="Create a segment such as “Newsletter subscribers” (everyone who allows marketing e-mail), or import a static list, then use it in a broadcast."
      create={{
        label: 'New segment',
        initial: { mode: 'dynamic', source: '' },
        fields: (state, set, errors) => (
          <>
            <Field label="Mode" error={errors.mode} hint="Dynamic rules recompute; a static list or snapshot keeps exact members.">
              <Select value={state.mode} onChange={(e) => set({ ...state, mode: e.target.value as Mode })}>
                <option value="dynamic">Dynamic rule</option>
                <option value="static">Static list</option>
                <option value="snapshot">Snapshot of another segment</option>
              </Select>
            </Field>
            {state.mode === 'snapshot' && <SnapshotSource value={state.source} onChange={(source) => set({ ...state, source })} />}
          </>
        ),
        validate: (state) => {
          const errors: Record<string, string> = {};
          if (state.mode === 'snapshot' && !state.source) errors.mode = 'Choose the segment to snapshot.';
          return errors;
        },
        content: () => ({ description: '', mode: 'dynamic', condition: { consent: 'marketing_email' } }),
        create: async (name, state) => {
          if (state.mode === 'snapshot') {
            const r = await api.call('audiences.snapshot', { sourceSegmentId: state.source, name });
            return { artifactId: r.artifactId };
          }
          const content =
            state.mode === 'static'
              ? { description: '', mode: 'static' as const }
              : { description: '', mode: 'dynamic' as const, condition: { consent: 'marketing_email' } };
          const r = await api.call('artifacts.create', { type: 'segment', name, content });
          return { artifactId: r.artifactId };
        },
      }}
    />
  );
}

function SnapshotSource({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const list = useApi(() => api.call('artifacts.list', { type: 'segment' as never, limit: 200 }), []);
  const items = (list.data?.artifacts ?? []).filter((a) => a.publishedVersion);
  return (
    <Field label="Source segment" hint="Its current members are copied and frozen. Publish it first.">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{list.loading ? 'Loading…' : list.error ? `Couldn't load: ${list.error}` : 'Choose a live segment…'}</option>
        {items.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} · v{a.publishedVersion}
          </option>
        ))}
      </Select>
    </Field>
  );
}
