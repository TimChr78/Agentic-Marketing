import { ArrowRight, ListChecks, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errText, type Out } from '../../app/api';
import { ButtonLink } from '../../app/links';
import { useCrumbs } from '../../app/page';
import { Link } from '../../app/router';
import { useWorkspace } from '../../app/session';
import { GallerySkeleton } from '../../features/phase28/content/GallerySkeleton';
import { Alert, Button, Checkbox, EmptyState, Field, Input, LoadingBlock, Mono, PageHeader, Select, StatusPill, Tag } from '../../ui';
import { pageWidth } from '../../ui/layout';

// Recipes (#150, #526): the gallery of installable marketing loops. Preview resolves the
// parameters and checks prerequisites; "Create drafts" installs version 1 drafts and never
// publishes. A person (or an agent) then reviews and submits them through the normal approval path.

type Recipe = Out<'recipes.get'>['recipe'];
type RecipeSummary = Out<'recipes.list'>['recipes'][number];
type Preview = Out<'recipes.preview'>;
type Installed = Out<'recipes.install'>;
type ParamValue = string | number | boolean;

type Values = Record<string, ParamValue>;

const initialValues = (recipe: Recipe): Values =>
  Object.fromEntries(recipe.parameters.filter((p) => p.default !== undefined).map((p) => [p.key, p.default as ParamValue]));

/** "1 draft" and "2 drafts": the notice names how many the earlier install created. */
const drafts = (count: number) => `${count} draft${count === 1 ? '' : 's'}`;

/** The parameters an install sent, as the labels the form showed, so a late result can name them. */
const parametersSummary = (recipe: Recipe, values: Values): string[] =>
  recipe.parameters
    .filter((p) => values[p.key] !== undefined && values[p.key] !== '')
    .slice(0, 4)
    .map((p) => `${p.label}: ${String(values[p.key])}`);

export default function RecipesPage({ embedded = false }: { embedded?: boolean }) {
  useCrumbs([{ label: embedded ? 'Starters' : 'Recipes' }]);
  const { can } = useWorkspace();
  const [list, setList] = useState<RecipeSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [values, setValues] = useState<Values>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [installed, setInstalled] = useState<Installed | null>(null);
  // An install that finished after the person edited a parameter (#961). Its drafts exist on the
  // server, so it is reported as theirs — clearly labelled — instead of disappearing, but it never
  // marks the parameters now on screen as installed.
  const [earlierInstall, setEarlierInstall] = useState<{ artifacts: Installed['artifacts']; summary: string[] } | null>(null);
  const [earlierInstallError, setEarlierInstallError] = useState<{ message: string; summary: string[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which read the error belongs to, so Retry repeats that read instead of always the list (#966).
  // `detail` covers `recipes.get` and the initial `recipes.preview`, the two reads a selected
  // starter needs.
  const [failedRead, setFailedRead] = useState<'list' | 'detail' | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const canWrite = can('artifacts:write');
  // Never show the previous starter's form while the newly selected one is loading.
  const activeRecipe = recipe?.id === selected ? recipe : null;
  // A failed detail read is shown in the detail panel, not only above the gallery: the panel must
  // not sit on "Loading the starter" as if the read were still in flight.
  const detailLoadFailed = failedRead === 'detail' && !activeRecipe;

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    setFailedRead(null);
    try {
      const r = await api.call('recipes.list', {});
      setList(r.recipes);
      setSelected((current) => current ?? r.recipes[0]?.id ?? null);
    } catch (e) {
      setError(errText(e));
      setFailedRead('list');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadSeq = useRef(0);
  // A parameter edit moves this generation, so an install that resolves later can tell that it no
  // longer belongs to the values on screen (#961).
  const paramsGeneration = useRef(0);
  // Installs are sequenced on their own, so a check that bumps `loadSeq` leaves them alone.
  const installSeq = useRef(0);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const load = useCallback(async (recipeId: string) => {
    // Only the latest selection may commit state (#616): a slower earlier read must not overwrite
    // the starter the person is now looking at.
    const seq = ++loadSeq.current;
    // Selecting a starter is a new parameter generation, and it supersedes any install still in
    // flight (#961 review): leaving A and coming back reloads A's defaults, so an install started
    // for A's earlier values must not be reported as this starter's install. Clearing the
    // installing state keeps the button honest for the starter now on screen.
    paramsGeneration.current += 1;
    installSeq.current += 1;
    setInstalling(false);
    setError(null);
    setFailedRead(null);
    setCheckError(null);
    setInstalled(null);
    setEarlierInstall(null);
    setEarlierInstallError(null);
    setRecipe(null);
    setPreview(null);
    try {
      const got = await api.call('recipes.get', { recipeId });
      if (seq !== loadSeq.current) return;
      setRecipe(got.recipe);
      const initial = initialValues(got.recipe);
      setValues(initial);
      const nextPreview = await api.call('recipes.preview', { recipeId, params: initial });
      if (seq !== loadSeq.current) return;
      setPreview(nextPreview);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(errText(e));
      setFailedRead('detail');
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
    // A parameter edit makes every derived result stale (#933). The preview, its prerequisite
    // check and an install success all describe the *old* parameters, so they are dropped, and
    // the sequence moves on so an in-flight check or install for them cannot commit.
    loadSeq.current += 1;
    paramsGeneration.current += 1;
    setPreview(null);
    setCheckError(null);
    setInstalled(null);
    setEarlierInstall(null);
    setEarlierInstallError(null);
    setError(null);
    setFailedRead(null);
  };

  /** Retry repeats the read that failed (#966): the selected starter's detail, or the gallery. */
  const retry = () => {
    if (failedRead === 'detail' && selected) void load(selected);
    else void loadList();
  };

  const check = async () => {
    if (!recipe) return;
    // A check belongs to one set of parameters and one selection: it takes the next sequence, so
    // an older check that resolves later is discarded (#792, #933).
    const seq = ++loadSeq.current;
    setChecking(true);
    setError(null);
    setCheckError(null);
    try {
      const next = await api.call('recipes.preview', { recipeId: recipe.id, params: values });
      if (seq !== loadSeq.current) return;
      setPreview(next);
    } catch (e) {
      if (seq === loadSeq.current) setCheckError(errText(e));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    if (!recipe) return;
    // An install has its own sequence: it belongs to the starter it was started for and the
    // parameter generation it sends, so a prerequisite check (a read, not a new set of parameters)
    // cannot displace its result (#965 review B).
    const seq = ++installSeq.current;
    const recipeId = recipe.id;
    const params = values;
    const generation = paramsGeneration.current;
    const summary = parametersSummary(recipe, params);
    setInstalling(true);
    setError(null);
    setEarlierInstall(null);
    setEarlierInstallError(null);
    try {
      const out = await api.call('recipes.install', { recipeId, params });
      if (seq !== installSeq.current) return; // a newer install replaced this one
      if (recipeId !== selectedRef.current) return; // the person left this starter (#792)
      if (generation === paramsGeneration.current) {
        setInstalled(out);
        return;
      }
      // The values changed while this ran. The server did create the drafts, so dropping the
      // response silently made people install a second full set (#961): report it, labelled as
      // the earlier parameters', without marking these as installed.
      setEarlierInstall({ artifacts: out.artifacts, summary });
    } catch (e) {
      if (seq !== installSeq.current) return;
      if (recipeId !== selectedRef.current) return;
      if (generation === paramsGeneration.current) {
        setError(errText(e));
        return;
      }
      // A failure creates nothing to lose track of, but the person did click: it is shown rather
      // than swallowed, labelled with the parameters it ran for (#961).
      setEarlierInstallError({ message: errText(e), summary });
    } finally {
      if (seq === installSeq.current) setInstalling(false);
    }
  };

  return (
    <div className={embedded ? 'space-y-5' : pageWidth('default', 'space-y-5')}>
      {!embedded && (
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
      )}

      <section aria-labelledby="starters-gallery" className="space-y-3">
        <div>
          <h2 id="starters-gallery" className="text-[14px] font-semibold text-fg">
            Start from an existing pattern
          </h2>
          <p className="text-[12px] leading-[18px] text-muted">
            Choose a starter to preview its parameters and prerequisites. Creating drafts never publishes or sends anything.
          </p>
        </div>

        {error && !detailLoadFailed && (
          <Alert tone="bad" title="That did not work" action={<Button onClick={retry}>Retry</Button>}>
            {error}
          </Alert>
        )}

        {loading ? (
          <GallerySkeleton label="Loading starters" minWidth={260} tileHeight={176} tiles={3} />
        ) : list.length === 0 ? (
          <EmptyState title="No recipes" action={<ButtonLink to="/content/templates">Open e-mail templates</ButtonLink>}>
            This server has no starter recipes. Create a template from scratch.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  aria-pressed={selected === r.id}
                  onClick={() => setSelected(r.id)}
                  className={`flex h-full w-full flex-col rounded-lg border bg-surface p-4 text-left transition-colors ${
                    selected === r.id ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-control'
                  }`}
                >
                  <span className="text-[11px] font-medium tracking-[0.08em] text-muted uppercase">Starter</span>
                  <span className="mt-1 flex items-start gap-2">
                    <span className="min-w-0 flex-1 text-[14px] font-semibold text-fg">{r.title}</span>
                    <span className="text-[11px] text-muted">v{r.version}</span>
                  </span>
                  <span className="mt-1 block text-[12px] leading-[18px] text-muted">{r.description}</span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    <Tag>{r.artifacts} drafts</Tag>
                    <Tag>{r.parameters.length} parameters</Tag>
                    <Tag>{r.prerequisites} prerequisites</Tag>
                  </span>
                  <span className="mt-auto flex items-center gap-1.5 pt-3 text-[12px] font-medium text-accent">
                    Choose starter <ArrowRight size={13} aria-hidden />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && !loading && list.length > 0 && (
        <section aria-labelledby="starter-detail" className="space-y-4 rounded-lg border border-line bg-surface p-4">
          {activeRecipe ? (
            <>
              <div>
                <h2 id="starter-detail" className="text-[14px] font-semibold text-fg">
                  {activeRecipe.title}
                </h2>
                <p className="text-[12px] leading-[18px] text-muted">{activeRecipe.description}</p>
              </div>

              <section aria-labelledby="starter-parameters" className="space-y-2">
                <h3 id="starter-parameters" className="text-[13px] font-semibold">
                  Parameters
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  {activeRecipe.parameters.map((p) => {
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
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="secondary" loading={checking} onClick={() => void check()}>
                    Check prerequisites
                  </Button>
                  {preview && (
                    <span className="text-[12px] text-muted">
                      {preview.ready ? 'Everything is in place.' : 'One or more prerequisites are missing.'}
                    </span>
                  )}
                </div>
                {checkError && (
                  <Alert tone="bad" title="Could not check the starter prerequisites">
                    {checkError} Try again.
                  </Alert>
                )}
              </section>

              {preview && (
                <section aria-labelledby="starter-prerequisites" className="space-y-2">
                  <h3 id="starter-prerequisites" className="text-[13px] font-semibold">
                    Prerequisites
                  </h3>
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
                <section aria-labelledby="starter-drafts" className="space-y-2">
                  <h3 id="starter-drafts" className="text-[13px] font-semibold">
                    Drafts this creates ({preview.artifacts.length})
                  </h3>
                  <ul className="divide-y divide-line rounded-md border border-line">
                    {preview.artifacts.map((a) => (
                      <li key={a.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                        <Tag>{a.type}</Tag>
                        <span className="min-w-0 flex-1 truncate font-medium">{a.name}</span>
                        <Mono>{a.key}</Mono>
                      </li>
                    ))}
                  </ul>
                  <p className="text-[12px] leading-[18px] text-muted">
                    The ids show how references resolve in this preview. Nothing is written until you create the drafts; the install gives
                    each draft a fresh id.
                  </p>
                </section>
              )}

              <section aria-labelledby="starter-checklist" className="space-y-2">
                <h3 id="starter-checklist" className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <ListChecks size={14} aria-hidden /> Review checklist
                </h3>
                <ul className="list-disc space-y-1 pl-5 text-[13px] text-fg-2">
                  {activeRecipe.checklist.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </section>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="primary"
                  icon={<ArrowRight size={14} />}
                  mutation
                  loading={installing}
                  disabled={!canWrite || !preview?.ready}
                  onClick={() => void install()}
                >
                  Create drafts
                </Button>
                {!canWrite && <span className="text-[12px] text-muted">Creating artifacts needs artifacts:write.</span>}
                {preview && !preview.ready && (
                  <span className="text-[12px] text-muted">
                    A required published purpose or template is missing. Create drafts is unavailable.
                  </span>
                )}
              </div>
              <p className="text-[12px] leading-[18px] text-muted">Nothing is published or sent by creating drafts.</p>

              {installing && (
                <p role="status" aria-live="polite" className="text-[12px] text-muted">
                  Creating starter drafts. Nothing will be published or sent.
                </p>
              )}

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

              {earlierInstall && (
                <Alert tone="warn" title={`Your earlier install finished and created ${drafts(earlierInstall.artifacts.length)}`}>
                  <p>
                    It used the parameters from before your last edit, so these drafts are for those earlier values, not the ones above.
                    They already exist: open one to review it, and create drafts again only if you want a second set.
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
                    {earlierInstall.summary.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    {earlierInstall.artifacts.map((a) => (
                      <li key={a.artifactId}>
                        <Link to={`/artifacts/${a.artifactId}`} className="font-medium text-accent hover:underline">
                          {a.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Alert>
              )}

              {earlierInstallError && (
                <Alert tone="bad" title="Your earlier install did not finish">
                  <p>
                    It ran with the parameters from before your last edit, so this is not an error for the values above:{' '}
                    {earlierInstallError.message}
                  </p>
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted">
                    {earlierInstallError.summary.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </Alert>
              )}
            </>
          ) : detailLoadFailed ? (
            <Alert tone="bad" title="Could not load the starter" action={<Button onClick={retry}>Retry</Button>}>
              {error} Try again.
            </Alert>
          ) : (
            <LoadingBlock geometry="detail" label="Loading the starter" />
          )}
        </section>
      )}
    </div>
  );
}
