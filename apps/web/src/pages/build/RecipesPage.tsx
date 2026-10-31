import { ArrowRight, ListChecks, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { Alert, Button, Card, Checkbox, EmptyState, Field, Input, Mono, PageHeader, Select, StatusPill, Tag } from '../../ui';
import { pageWidth } from '../../ui/layout';

// Recipes (#150): the gallery of installable marketing loops. Preview resolves the parameters and
// checks prerequisites; "Create drafts" installs version 1 drafts and never publishes. A person
// (or an agent) then reviews and submits them through the normal approval path.

type Recipe = Out<'recipes.get'>['recipe'];
type RecipeSummary = Out<'recipes.list'>['recipes'][number];
type Preview = Out<'recipes.preview'>;
type Installed = Out<'recipes.install'>;
type ParamValue = string | number | boolean;

type Values = Record<string, ParamValue>;

const initialValues = (recipe: Recipe): Values =>
  Object.fromEntries(recipe.parameters.filter((p) => p.default !== undefined).map((p) => [p.key, p.default as ParamValue]));

export default function RecipesPage() {
  useCrumbs([{ label: 'Recipes' }]);
  const { can } = useWorkspace();
  const [list, setList] = useState<RecipeSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [values, setValues] = useState<Values>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [installed, setInstalled] = useState<Installed | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = can('artifacts:write');

  useEffect(() => {
    let live = true;
    void api
      .call('recipes.list', {})
      .then((r) => {
        if (!live) return;
        setList(r.recipes);
        setSelected((current) => current ?? r.recipes[0]?.id ?? null);
      })
      .catch((e) => live && setError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(async (recipeId: string) => {
    setError(null);
    setInstalled(null);
    setRecipe(null);
    setPreview(null);
    try {
      const got = await api.call('recipes.get', { recipeId });
      setRecipe(got.recipe);
      const initial = initialValues(got.recipe);
      setValues(initial);
      setPreview(await api.call('recipes.preview', { recipeId, params: initial }));
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    if (selected) void load(selected);
  }, [selected, load]);

  const setParam = (key: string, value: ParamValue | undefined) => {
    setValues((current) => {
      const next = { ...current };
      if (value === undefined || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
    setInstalled(null);
  };

  const check = async () => {
    if (!recipe) return;
    setChecking(true);
    setError(null);
    try {
      setPreview(await api.call('recipes.preview', { recipeId: recipe.id, params: values }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!recipe) return;
    setInstalling(true);
    setError(null);
    try {
      const out = await api.call('recipes.install', { recipeId: recipe.id, params: values });
      setInstalled(out);
      setPreview(await api.call('recipes.preview', { recipeId: recipe.id, params: values }));
    } catch (e) {
      setError(errText(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className={pageWidth('default')}>
      <PageHeader
        title="Recipes"
        description="Installable marketing loops: a welcome journey with double opt-in, a lead-magnet drip, a weekly newsletter and a win-back. A recipe creates version 1 drafts with your parameters filled in. Nothing is sent or published until a person approves it."
        meta={
          <>
            <Tag icon={<Sparkles size={12} />}>{list.length} recipes</Tag>
            <span>Drafts only; the approval policy decides what goes live.</span>
          </>
        }
      />

      {error && (
        <Alert tone="bad" title="That did not work" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]">
        <Card title="Gallery" description="Pick a loop to preview." padded={false}>
          {loading && <p className="px-4 py-3 text-[13px] text-muted">Loading recipes…</p>}
          <ul className="divide-y divide-line">
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r.id)}
                  className={`w-full px-4 py-3 text-left transition-colors hover:bg-surface-2 ${selected === r.id ? 'bg-accent-soft' : ''}`}
                >
                  <span className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold text-fg">{r.title}</span>
                    <span className="ml-auto text-[11px] text-muted">v{r.version}</span>
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{r.description}</span>
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    <Tag>{r.artifacts} drafts</Tag>
                    <Tag>{r.parameters.length} parameters</Tag>
                    <Tag>{r.prerequisites} prerequisites</Tag>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        {!selected && !loading ? (
          <EmptyState title="No recipes">This server ships no recipes.</EmptyState>
        ) : recipe ? (
          <div className="min-w-0 space-y-5">
            <Card title={recipe.title} description={recipe.description}>
              <div className="space-y-5 p-4">
                <section>
                  <h3 className="mb-2 text-[13px] font-semibold">Parameters</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {recipe.parameters.map((p) => {
                      const value = values[p.key];
                      if (p.type === 'boolean')
                        return (
                          <Checkbox
                            key={p.key}
                            label={p.label}
                            hint={p.description || undefined}
                            checked={value === true}
                            onChange={(e) => setParam(p.key, e.target.checked)}
                          />
                        );
                      if (p.options?.length)
                        return (
                          <Field key={p.key} label={p.label} hint={p.description || undefined} required={p.required}>
                            <Select value={String(value ?? '')} onChange={(e) => setParam(p.key, e.target.value || undefined)}>
                              {!p.required && <option value="">—</option>}
                              {p.options.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </Select>
                          </Field>
                        );
                      return (
                        <Field
                          key={p.key}
                          label={p.label}
                          hint={p.description || undefined}
                          required={p.required}
                          unit={p.type === 'duration' ? 'ISO 8601' : undefined}
                        >
                          <Input
                            type={p.type === 'number' ? 'number' : p.type === 'email' ? 'email' : p.type === 'url' ? 'url' : 'text'}
                            value={String(value ?? '')}
                            placeholder={p.type === 'datetime' ? '2026-11-06T07:00:00Z' : undefined}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === '') return setParam(p.key, undefined);
                              if (p.type === 'number') {
                                const n = Number(raw);
                                return setParam(p.key, Number.isFinite(n) ? n : undefined);
                              }
                              setParam(p.key, raw);
                            }}
                          />
                        </Field>
                      );
                    })}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button variant="secondary" loading={checking} onClick={() => void check()}>
                      Check prerequisites
                    </Button>
                    {preview && (
                      <span className="text-[12px] text-muted">
                        {preview.ready ? 'Everything is in place.' : 'One or more prerequisites are missing.'}
                      </span>
                    )}
                  </div>
                </section>

                {preview && (
                  <section>
                    <h3 className="mb-2 text-[13px] font-semibold">Prerequisites</h3>
                    <ul className="space-y-1.5">
                      {preview.prerequisites.map((p) => (
                        <li key={`${p.kind}-${p.description}`} className="flex items-start gap-2 text-[13px]">
                          <StatusPill tone={p.ok ? 'good' : 'warn'}>{p.ok ? 'Ready' : 'Missing'}</StatusPill>
                          <span className="min-w-0 flex-1 text-fg-2">{p.ok ? p.description : p.message}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {preview && (
                  <section>
                    <h3 className="mb-2 text-[13px] font-semibold">Drafts this creates ({preview.artifacts.length})</h3>
                    <ul className="divide-y divide-line rounded-md border border-line">
                      {preview.artifacts.map((a) => (
                        <li key={a.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                          <Tag>{a.type}</Tag>
                          <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                          <Mono>{a.key}</Mono>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1.5 text-[12px] text-muted">
                      The ids show how references resolve in this preview. Nothing is written until you create the drafts; the install gives
                      each draft a fresh id.
                    </p>
                  </section>
                )}

                <section>
                  <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold">
                    <ListChecks size={14} /> Review checklist
                  </h3>
                  <ul className="list-disc space-y-1 pl-5 text-[13px] text-fg-2">
                    {recipe.checklist.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </section>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="primary"
                    icon={<ArrowRight size={14} />}
                    loading={installing}
                    disabled={!canWrite || !preview?.ready}
                    onClick={() => void install()}
                  >
                    Create drafts
                  </Button>
                  {!canWrite && <span className="text-[12px] text-muted">Creating artifacts needs artifacts:write.</span>}
                  {preview && !preview.ready && (
                    <span className="text-[12px] text-muted">Fix the prerequisites before creating drafts.</span>
                  )}
                </div>

                {installed && (
                  <Alert tone="good" title={`Created ${installed.artifacts.length} drafts`}>
                    <p>Review them, then submit them together through the approval policy; nothing has been published.</p>
                    <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                      {installed.artifacts.map((a) => (
                        <li key={a.artifactId}>
                          <Link to={`/artifacts/${a.artifactId}`} className="font-medium text-accent hover:underline">
                            {a.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Alert>
                )}
              </div>
            </Card>
          </div>
        ) : (
          <Card>
            <p className="p-4 text-[13px] text-muted">Loading the recipe…</p>
          </Card>
        )}
      </div>
    </div>
  );
}
