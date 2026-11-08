# Phase 27 · source preservation ledger

Baseline: `e9bd7c97f064cc70863ca924c8157e07e6722f9d` (`origin/feat/phase-27` at checkout). This supplements each contract's
Inventory and destination table. Source paths/line references describe the baseline, not future code.

Every listed field, action, tab, schema property and conditional state remains in its corresponding
contract destination. Repeated controls are deduplicated per file below, never removed from the UI.
Dynamic labels/config fields retain the full server schema, including fields without a literal JSX
label. Unknown artifact keys and condition shapes round-trip untouched. This is a source ledger,
not user-facing copy: internal names below must not appear in normal product labels.

| Owner | Destination rule for all entries below |
|---|---|
| A | Family list/detail Content and named tabs/drawers in audience-marketing.md; purposes edit remains in Consent, editorial queue remains Topics |
| C | Content named tabs, editors, pickers and detail drawers in content.md; existing preview helpers stay compatible |
| S | Settings canonical destination, channel/section drawer and account Preferences in settings.md |
| J | Palette/toolbar/Step or Journey inspector/Check/Simulate in journey-builder.md; frozen model semantics |
| R | Same public page and brand-resolved renderer in recipients.md; same routes/headers and machine-facing outputs |
| D | Same real product family destination in demo.md, except explicit legacy demo cuts listed in README |
| I | Shared host retains every action/tab/conditional; optional template slots cannot shrink old surfaces |

The ledger captures literal labels, action text, option/tab declarations, source field expressions,
command calls, and state/access branches. Human destination summaries are in the six contracts.
A builder must compare the full owned source against this ledger before deleting controls; a
read-budget target never authorizes a cut. All dynamic schema fields remain in the same editing
section even when a compact summary shows only name/status. Existing validation bounds/defaults
are preserved, not redesigned by the mock's sample values.


## A · #525


### apps/web/src/pages/build/FormsPage.tsx

[Baseline source](../../../apps/web/src/pages/build/FormsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 9 | `title="Forms"` |
| 11 | `emptyTitle="No forms yet"` |
| 12 | `emptyText="Create a signup form for your newsletter. You need a published confirmation e-mail (with {{ confirm_url }}) for double opt-in."` |
| 14 | `label: 'New form',` |
| 18 | `label="Confirmation e-mail"` |
| 19 | `hint="Sent for double opt-in; it must contain {{ confirm_url }}. You can change this later."` |


### apps/web/src/pages/build/FormPage.tsx

[Baseline source](../../../apps/web/src/pages/build/FormPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 6 | `<ArtifactDetailPage id={params.id} crumbs={[{ label: 'Forms', to: '/audience/forms' }]} wide editor={(p) => <FormEditor {...p} />} />` |


### apps/web/src/pages/build/SegmentsPage.tsx

[Baseline source](../../../apps/web/src/pages/build/SegmentsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 13 | `title="Segments"` |
| 15 | `emptyTitle="No segments yet"` |
| 16 | `emptyText="Create a segment such as “Newsletter subscribers” (everyone who allows marketing e-mail), or import a static list, then use it in a broadcast."` |
| 18 | `label: 'New segment',` |
| 22 | `<Field label="Mode" error={errors.mode} hint="Dynamic rules recompute; a static list or snapshot keeps exact members.">` |
| 24 | `<option value="dynamic">Dynamic rule</option>` |
| 25 | `<option value="static">Static list</option>` |
| 26 | `<option value="snapshot">Snapshot of another segment</option>` |
| 40 | `const r = await api.call('audiences.snapshot', { sourceSegmentId: state.source, name });` |
| 47 | `const r = await api.call('artifacts.create', { type: 'segment', name, content });` |
| 59 | `<Field label="Source segment" hint="Its current members are copied and frozen. Publish it first.">` |
| 61 | `<option value="">{list.loading ? 'Loading…' : list.error ? ′Couldn't load: ${list.error}′ : 'Choose a live segment…'}</option>` |
| 63 | `<option key={a.id} value={a.id}>` |


### apps/web/src/pages/build/SegmentPage.tsx

[Baseline source](../../../apps/web/src/pages/build/SegmentPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 8 | `crumbs={[{ label: 'Segments', to: '/audience/segments' }]}` |


### apps/web/src/pages/build/ExperiencesPage.tsx

[Baseline source](../../../apps/web/src/pages/build/ExperiencesPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 7 | `title="Experiences"` |
| 9 | `emptyTitle="No experiences yet"` |
| 10 | `emptyText="Create one for an element on your site marked with data-am-placement, such as a newsletter banner under articles."` |
| 12 | `label: 'New experience',` |


### apps/web/src/pages/build/ExperiencePage.tsx

[Baseline source](../../../apps/web/src/pages/build/ExperiencePage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 8 | `crumbs={[{ label: 'Experiences', to: '/marketing/experiences' }]}` |
| 9 | `extraTabs={[{ key: 'results', label: 'Results', render: (a) => <ExperienceResults artifact={a} /> }]}` |


### apps/web/src/pages/build/TopicsPage.tsx

[Baseline source](../../../apps/web/src/pages/build/TopicsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 20 | `title: string;` |
| 29 | `const EMPTY: Draft = { title: '', angle: '', audience: '', keyword: '', tags: '', targetDate: '', signals: '' };` |
| 32 | `useCrumbs([{ label: 'Topics' }]);` |
| 35 | `const canWrite = can('artifacts:write');` |
| 37 | `const [status, setStatus] = useState('');` |
| 38 | `const [owner, setOwner] = useState('');` |
| 39 | `const [tag, setTag] = useState('');` |
| 40 | `const [minScore, setMinScore] = useState('');` |
| 41 | `const [creating, setCreating] = useState(false);` |
| 42 | `const [draft, setDraft] = useState<Draft>(EMPTY);` |
| 43 | `const [saving, setSaving] = useState(false);` |
| 47 | `api.call('content.topics.list', {` |
| 57 | `const set = (key: keyof Draft) => (event: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: event.target.value }));` |
| 67 | `const result = await api.call('content.topics.create', {` |
| 68 | `title: draft.title.trim(),` |
| 85 | `toast.error(errText(e));` |
| 93 | `const result = await api.call('content.topics.toBrief', { topicId: topic.id });` |
| 103 | `await api.call('content.topics.archive', { topicId: topic.id });` |
| 114 | `title="Topics"` |
| 119 | `New topic` |
| 126 | `loading={list.loading}` |
| 127 | `error={list.error}` |
| 137 | `aria-label="Filter by owner"` |
| 146 | `aria-label="Filter by tag"` |
| 152 | `<Select compact aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)}>` |
| 154 | `<option key={value \|\| 'all'} value={value}>` |
| 159 | `<Select compact aria-label="Minimum score" value={minScore} onChange={(e) => setMinScore(e.target.value)}>` |
| 161 | `<option key={value \|\| 'any'} value={value}>` |
| 184 | `title="New topic"` |
| 188 | `<Button variant="primary" loading={saving} disabled={!draft.title.trim()} onClick={() => void create()}>` |
| 189 | `Add topic` |
| 195 | `<Field label="Title" required>` |
| 198 | `<Field label="Angle" hint="One line: the specific take, not the whole argument.">` |
| 201 | `<Field label="Audience">` |
| 205 | `<Field label="Keyword" hint="Optional primary keyword or intent.">` |
| 208 | `<Field label="Target date" hint="A target, not a calendar entry.">` |
| 212 | `<Field label="Tags" hint="Comma separated.">` |
| 215 | `<Field label="Signals" hint="One per line: a source item, a community thread or a manual idea. Each adds 5 points.">` |
| 219 | `Near-duplicates are linked to the existing topic instead of being silently created twice.` |


### apps/web/src/pages/audience/ConsentPage.tsx

[Baseline source](../../../apps/web/src/pages/audience/ConsentPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 12 | `Alert,` |
| 13 | `Button,` |
| 14 | `Card,` |
| 15 | `Drawer,` |
| 16 | `EmptyState,` |
| 17 | `Field,` |
| 19 | `Input,` |
| 20 | `LoadingBlock,` |
| 21 | `Meta,` |
| 22 | `Mono,` |
| 23 | `PageHeader,` |
| 24 | `Select,` |
| 25 | `StatusPill,` |
| 26 | `TableFrame,` |
| 27 | `Tabs,` |
| 28 | `Tag,` |
| 29 | `Textarea,` |
| 46 | `useCrumbs([{ label: 'Consent' }]);` |
| 48 | `const [value, setValue] = useState('');` |
| 49 | `const [lookupError, setLookupError] = useState<string \| null>(null);` |
| 50 | `const [lookingUp, setLookingUp] = useState(false);` |
| 51 | `const [person, setPerson] = useState<Lookup \| null>(null);` |
| 52 | `const [recording, setRecording] = useState(false);` |
| 54 | `const purposes = useApi(() => api.call('purposes.list', {}), [], { skip: !can('artifacts:read') });` |
| 55 | `const summary = useApi(() => api.call('consent.summary', {}), [], { skip: !can('profiles:read') });` |
| 59 | `const profile = useApi(() => api.call('profiles.get', { profileId: person!.id }), [person?.id], { skip: !person });` |
| 60 | `const history = useApi(() => api.call('consent.history', { profileId: person!.id }), [person?.id], { skip: !person });` |
| 80 | `const r = await api.call('profiles.find', { type: 'email', value: q });` |
| 94 | `const canRecord = can('profiles:write');` |
| 99 | `title="Consent"` |
| 111 | `Purposes in force` |
| 115 | `{!can('artifacts:read') ? (` |
| 119 | `) : purposes.loading ? (` |
| 120 | `<LoadingBlock lines={3} label="Loading purposes" />` |
| 121 | `) : purposes.error ? (` |
| 122 | `<Alert tone="bad" title="Couldn't load the purposes" onRetry={purposes.reload}>` |
| 123 | `{purposes.error}` |
| 172 | `title="Look up a person"` |
| 184 | `<Field label="E-mail or profile id" className="min-w-[240px] flex-1" error={lookupError}>` |
| 190 | `<Button type="submit" loading={lookingUp} icon={<Search size={14} />}>` |
| 191 | `Look up` |
| 198 | `title="Consent ledger"` |
| 203 | `Record consent` |
| 209 | `{profile.loading ? (` |
| 210 | `<LoadingBlock lines={2} label="Loading person" />` |
| 211 | `) : profile.error ? (` |
| 213 | `{profile.error}` |
| 237 | `loading={history.loading}` |
| 238 | `error={history.error}` |
| 243 | `<EmptyState compact title="No consent records yet">` |
| 244 | `Record what the person agreed to, refused or withdrew, with the evidence you have.` |
| 256 | `purposes={(purposes.data?.purposes ?? []).map((p) => ({ key: p.key, name: p.name }))}` |
| 276 | `purposes: { key: string; name: string }[];` |
| 281 | `const [purpose, setPurpose] = useState(purposes[0]?.key ?? 'marketing_email');` |
| 282 | `const [status, setStatus] = useState<Status>('granted');` |
| 283 | `const [channel, setChannel] = useState('');` |
| 284 | `const [source, setSource] = useState<'form' \| 'import' \| 'api' \| 'unsubscribe'>('form');` |
| 285 | `const [note, setNote] = useState('');` |
| 286 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 287 | `const [error, setError] = useState<string \| null>(null);` |
| 288 | `const [busy, setBusy] = useState(false);` |
| 298 | `const r = await api.call('consent.record', {` |
| 324 | `title="Record consent"` |
| 329 | `<Button variant="primary" loading={busy} onClick={submit}>` |
| 342 | `<Field label="Purpose" error={errors.purpose} required hint="What the choice is about. From the purposes in force.">` |
| 346 | `<option key={p.key} value={p.key}>` |
| 363 | `<Field label="Choice" required>` |
| 365 | `<option value="granted">Granted</option>` |
| 366 | `<option value="denied">Denied</option>` |
| 367 | `<option value="withdrawn">Withdrawn</option>` |
| 368 | `<option value="objected">Objected</option>` |
| 371 | `<Field label="Channel" hint="Any channel, or the one this choice is for.">` |
| 373 | `<option value="">Any channel</option>` |
| 374 | `<option value="email">E-mail</option>` |
| 375 | `<option value="web">Web</option>` |
| 376 | `<option value="sms">SMS</option>` |
| 377 | `<option value="push">Push</option>` |
| 378 | `<option value="webhook">Webhook</option>` |
| 382 | `<Field label="Where it came from" hint="Kept as the record's source.">` |
| 384 | `<option value="form">A form</option>` |
| 385 | `<option value="import">An import</option>` |
| 386 | `<option value="api">An API or agent</option>` |
| 387 | `<option value="unsubscribe">An unsubscribe</option>` |
| 390 | `<Field label="Proof note" hint="What they saw or signed, and when. For example “Homepage newsletter checkbox v3, 2026-10-20”.">` |
| 404 | `const CONSENT_TAB_ITEMS: { key: ConsentTab; label: string }[] = [` |
| 405 | `{ key: 'consent', label: 'Consent' },` |
| 406 | `{ key: 'purposes', label: 'Purposes' },` |
| 407 | `{ key: 'topics', label: 'Topics' },` |
| 420 | `allowed: (tab) => (tab === 'consent' ? can('profiles:read') : can('artifacts:read')),` |
| 422 | `useCrumbs([{ label: active === 'consent' ? 'Consent' : active === 'purposes' ? 'Purposes' : 'Topics' }]);` |
| 428 | `This tab is unavailable.` |
| 431 | `<Tabs items={CONSENT_TAB_ITEMS} value={active} onChange={select} label="Consent">` |
| 433 | `<EmptyState title="Your role can't open this tab">` |


### apps/web/src/pages/insights/AlertsPage.tsx

[Baseline source](../../../apps/web/src/pages/insights/AlertsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useState } from 'react';` |
| 9 | `Alert,` |
| 10 | `Button,` |
| 11 | `Card,` |
| 12 | `Checkbox,` |
| 13 | `Drawer,` |
| 14 | `EmptyState,` |
| 15 | `Field,` |
| 17 | `Input,` |
| 18 | `LoadingBlock,` |
| 19 | `PageHeader,` |
| 20 | `Select,` |
| 21 | `StatusPill,` |
| 22 | `Table,` |
| 23 | `TableFrame,` |
| 24 | `Tag,` |
| 25 | `Td,` |
| 26 | `THead,` |
| 27 | `Th,` |
| 28 | `Tr,` |
| 72 | `const window = windowText(String(config.window ?? 'PT24H'));` |
| 74 | `const metric = config.metric === 'complaint' ? 'Complaint rate' : 'Bounce rate';` |
| 75 | `return ′${metric} above ${pct(Number(config.threshold ?? 0))} over ${window}, after at least ${num(Number(config.minSent ?? 100))} sent.′;` |
| 78 | `return ′Confirmed signups below ${num(Number(config.dropPercent ?? 50))}% of the previous ${window}, when the previous window had at least ${num(Number(config.minPrevious ?? 10))}.′;` |
| 80 | `const journey = config.journeyId ? (journeyName ?? String(config.journeyId)) : 'all journeys';` |
| 81 | `return ′More than ${num(Number(config.threshold ?? 5))} failed steps over ${window} for ${journey}.′;` |
| 109 | `metric: config.metric === 'complaint' ? 'complaint' : 'bounce',` |
| 110 | `deliverabilityWindow: String(config.window ?? 'PT24H'),` |
| 112 | `rule?.kind === 'deliverability' ? String((Number(config.threshold ?? 0.05) * 100).toFixed(3)).replace(/\.?0+$/, '') : '5',` |
| 113 | `minSent: String(config.minSent ?? 100),` |
| 114 | `signupWindow: rule?.kind === 'signup_drop' ? String(config.window ?? 'PT24H') : 'PT24H',` |
| 115 | `dropPercent: String(config.dropPercent ?? 50),` |
| 116 | `minPrevious: String(config.minPrevious ?? 10),` |
| 117 | `errorWindow: rule?.kind === 'journey_errors' ? String(config.window ?? 'PT1H') : 'PT1H',` |
| 118 | `errorThreshold: String(config.threshold ?? 5),` |
| 119 | `journeyId: String(config.journeyId ?? ''),` |
| 127 | `useCrumbs([{ label: 'Alerts' }]);` |
| 129 | `const admin = can('workspace:admin');` |
| 132 | `const [editing, setEditing] = useState<Rule \| 'new' \| null>(null);` |
| 133 | `const [historyRule, setHistoryRule] = useState<Rule \| null>(null);` |
| 135 | `const rules = useApi(() => api.call('alerts.list', {}), []);` |
| 136 | `const endpoints = useApi(() => api.call('webhooks.list', {}), []);` |
| 137 | `const members = useApi(() => api.call('members.list', {}), [], { skip: !admin });` |
| 139 | `const history = useApi(() => api.call('alerts.history', { limit: 50 }), [rules.data]);` |
| 140 | `const ruleHistory = useApi(() => api.call('alerts.history', { ruleId: historyRule?.id, limit: 200 }), [historyRule?.id], {` |
| 141 | `skip: !historyRule,` |
| 162 | `title: ′Delete “${rule.name}”?′,` |
| 169 | `await api.call('alerts.delete', { id: rule.id });` |
| 174 | `toast.error(errText(e));` |
| 180 | `const result = await api.call('alerts.test', { id: rule.id });` |
| 200 | `title="Alerts"` |
| 211 | `{rules.loading ? (` |
| 212 | `<LoadingBlock lines={4} label="Loading alert rules" />` |
| 213 | `) : rules.error ? (` |
| 214 | `<Alert tone="bad" title="Couldn't load alert rules" onRetry={rules.reload}>` |
| 215 | `{rules.error}` |
| 221 | `title="No alert rules yet"` |
| 225 | `Create the first alert` |
| 230 | `A useful first rule watches bounce rate over a day, or tells you when confirmed signups drop by half from the day before.` |
| 238 | `title={` |
| 245 | `description={ruleSummary(rule, rule.config.journeyId ? journeyName(String(rule.config.journeyId)) : undefined)}` |
| 259 | `History` |
| 267 | `Edit` |
| 269 | `<Button size="sm" variant="ghost" onClick={() => void remove(rule)} aria-label={′Delete ${rule.name}′}>` |
| 283 | `Recent history` |
| 285 | `{history.loading ? (` |
| 286 | `<LoadingBlock lines={3} label="Loading alert history" />` |
| 287 | `) : history.error ? (` |
| 288 | `<Alert tone="bad" title="Couldn't load alert history" onRetry={history.reload}>` |
| 289 | `{history.error}` |
| 293 | `<EmptyState title="Nothing has fired yet">` |
| 294 | `When a rule starts firing and when it recovers, the episode is recorded here.` |
| 299 | `<Table label="Alert history">` |
| 302 | `<Th>When</Th>` |
| 303 | `<Th>Rule</Th>` |
| 304 | `<Th>State</Th>` |
| 305 | `<Th align="right">Value</Th>` |
| 306 | `<Th align="right">Threshold</Th>` |
| 307 | `<Th>Window</Th>` |
| 334 | `title={editing === 'new' \|\| editing === null ? 'New alert rule' : ′Edit ${editing.name}′}` |
| 349 | `onError={(message) => toast.error(message)}` |
| 357 | `title={historyRule ? ′History · ${historyRule.name}′ : 'History'}` |
| 360 | `{ruleHistory.loading ? (` |
| 362 | `<LoadingBlock lines={4} label="Loading history" />` |
| 366 | `<EmptyState title="No episodes yet">This rule has not fired since it was created.</EmptyState>` |
| 416 | `const [form, setForm] = useState<FormState>(() => formFor(rule));` |
| 417 | `const [busy, setBusy] = useState(false);` |
| 419 | `const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));` |
| 421 | `const toggle = (key: 'webhookIds' \| 'userIds', id: string) =>` |
| 436 | `window: form.errorWindow,` |
| 437 | `threshold: Number(form.errorThreshold),` |
| 451 | `if (rule) await api.call('alerts.update', { id: rule.id, name: form.name.trim(), config, channels, enabled: form.enabled });` |
| 452 | `else await api.call('alerts.create', { name: form.name.trim(), kind, config, channels, enabled: form.enabled });` |
| 463 | `<Field label="Name" hint="What people see in the notification and history.">` |
| 467 | `<Field label="Kind" hint={kindExplanation(kind)}>` |
| 469 | `<option value="deliverability">Deliverability</option>` |
| 470 | `<option value="signup_drop">Signup drop</option>` |
| 471 | `<option value="journey_errors">Journey errors</option>` |
| 477 | `<Field label="Measure">` |
| 479 | `<option value="bounce">Bounce rate</option>` |
| 480 | `<option value="complaint">Complaint rate</option>` |
| 483 | `<Field label="Window">` |
| 486 | `<option key={w} value={w}>` |
| 492 | `<Field label="Threshold" unit="%" hint="Fires above this rate. Default 5% bounce, 0.1% complaint.">` |
| 502 | `<Field label="Minimum sent" hint="Do not fire until at least this many people were sent in the window.">` |
| 519 | `<Field label="Drop threshold" unit="%" hint="Fires when the new window is below this share of the previous one.">` |
| 522 | `<Field label="Minimum previous signups" hint="The previous window must have at least this many confirmed signups.">` |
| 531 | `<Select value={form.errorWindow} onChange={(e) => set('errorWindow', e.target.value)}>` |
| 539 | `<Field label="Failures above" hint="Fires when more than this many steps fail in the window.">` |
| 540 | `<Input type="number" min="1" step="1" value={form.errorThreshold} onChange={(e) => set('errorThreshold', e.target.value)} />` |
| 542 | `<Field label="Journey" hint="Leave empty to watch every journey in the workspace." className="sm:col-span-2">` |
| 544 | `<option value="">All journeys</option>` |
| 546 | `<option key={j.id} value={j.id}>` |
| 563 | `label={endpoint.name}` |
| 564 | `hint={endpoint.url}` |
| 580 | `label={member.name \|\| member.email}` |
| 581 | `hint={member.email}` |
| 593 | `label="Enabled"` |
| 594 | `hint="Paused rules keep their history but are not evaluated."` |
| 601 | `<Button variant="primary" loading={busy} onClick={() => void save()}>` |


### apps/web/src/pages/settings/PurposesPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/PurposesPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 25 | `useCrumbs([{ label: 'Purposes' }]);` |
| 29 | `const [current, list] = await Promise.all([api.call('purposes.list', {}), api.call('artifacts.list', { type: 'purposes', limit: 1 })]);` |
| 33 | `const summary = useApi(() => api.call('consent.summary', {}), [], { skip: !can('profiles:read') });` |
| 35 | `const [creating, setCreating] = useState(false);` |
| 36 | `const [error, setError] = useState<string \| null>(null);` |
| 41 | `const canWrite = can('artifacts:write');` |
| 48 | `const r = await api.call('artifacts.create', {` |
| 53 | `key: p.key,` |
| 75 | `title="Purposes"` |
| 87 | `Edit purposes` |
| 90 | `<Button variant="primary" icon={<Plus size={15} />} loading={creating} onClick={() => void create()}>` |
| 91 | `Create purposes` |
| 97 | `<Alert tone="info" title="No purposes artifact yet" className="mb-4">` |
| 105 | `<Alert tone="bad" title="Could not create the purposes artifact" className="mb-4">` |
| 110 | `loading={data.loading}` |
| 111 | `error={data.error}` |
| 115 | `empty={<EmptyState title="No purposes">Add purposes to the purposes artifact. Until then the built-in defaults apply.</EmptyState>}` |
| 117 | `<Table label="Purposes">` |
| 120 | `<Th>Purpose</Th>` |
| 121 | `<Th>Lawful basis</Th>` |
| 122 | `<Th>Channels</Th>` |
| 123 | `<Th>People</Th>` |
| 124 | `<Th>Double opt-in</Th>` |
| 152 | `{summary.loading ? (` |


### apps/web/src/features/artifacts/FormEditor.tsx

[Baseline source](../../../apps/web/src/features/artifacts/FormEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useRef, useState } from 'react';` |
| 20 | `[key: string]: unknown;` |
| 57 | `const COPY_DEFAULTS: { key: keyof BrandCopy; label: string; hint: string; rows: number }[] = [` |
| 58 | `{ key: 'confirmTitle', label: 'Confirm page title', hint: 'Default: Confirm your subscription', rows: 2 },` |
| 59 | `{ key: 'confirmBody', label: 'Confirm page body', hint: 'Default: One click and you are in.', rows: 3 },` |
| 60 | `{ key: 'confirmButton', label: 'Confirm button', hint: 'Default: Yes, subscribe me', rows: 2 },` |
| 61 | `{ key: 'expiredTitle', label: 'Expired page title', hint: 'Default: Link expired', rows: 2 },` |
| 63 | `key: 'expiredBody',` |
| 64 | `label: 'Expired page body',` |
| 70 | `export function FormEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<FormContent>) {` |
| 72 | `const remove = (key: keyof FormContent) => {` |
| 78 | `const purposes = useApi(() => api.call('purposes.list', {}), []);` |
| 79 | `const doubleOptIn = content.doubleOptIn ?? true;` |
| 80 | `const selectedPurposes = content.purposes ?? [];` |
| 86 | `<FieldGroup legend="Consent">` |
| 89 | `Purposes` |
| 96 | `{purposes.loading && <p className="text-[12px] text-muted">Loading purposes…</p>}` |
| 97 | `{purposes.error && (` |
| 98 | `<Alert tone="bad" title="Couldn't load the purposes" onRetry={purposes.reload}>` |
| 99 | `{purposes.error}` |
| 112 | `disabled={readOnly}` |
| 118 | `label={` |
| 123 | `hint={p?.description}` |
| 132 | `label="Consent text"` |
| 133 | `hint={′Shown next to the form. It is stored with each consent as proof. ${(content.consentText ?? '').length} / 2000 characters.′}` |
| 140 | `value={content.consentText ?? ''}` |
| 141 | `readOnly={readOnly}` |
| 150 | `label="Double opt-in: the person confirms by e-mail"` |
| 163 | `label="Confirmation e-mail"` |
| 164 | `hint="It must contain {{ confirm_url }} and use a purpose that does not need consent, such as onboarding."` |
| 170 | `value={content.confirmationTemplate}` |
| 178 | `<FieldGroup legend="Fields" hint="The e-mail field is always collected. Add the traits this form also keeps.">` |
| 180 | `value={content.traits ?? ['firstName']}` |
| 187 | `<FieldGroup legend="After submitting">` |
| 189 | `label="Success page"` |
| 190 | `hint="Where the browser goes after submitting, e.g. /thanks."` |
| 192 | `value={content.successUrl}` |
| 198 | `label="Confirmed page"` |
| 199 | `hint="Where the browser goes after the person confirms the double opt-in. Leave empty to show the branded confirmation page."` |
| 200 | `value={content.confirmedUrl}` |
| 206 | `label="Error page"` |
| 207 | `hint="Where the browser goes when the submission is refused; ?error=… is added. Optional."` |
| 208 | `value={content.errorUrl}` |
| 211 | `error={errors.errorUrl}` |
| 215 | `<FieldGroup legend="Security">` |
| 217 | `value={content.allowedOrigins ?? []}` |
| 224 | `checked={content.turnstile ?? false}` |
| 226 | `label="Require a Cloudflare Turnstile check"` |
| 237 | `<FieldGroup legend="Hosted pages" hint="The confirm and expired pages a subscriber sees on the links host.">` |
| 240 | `checked={!!content.hostedPages}` |
| 241 | `onChange={(v) => (v ? set({ hostedPages: content.hostedPages ?? {} }) : remove('hostedPages'))}` |
| 242 | `label="Use a different look for this form's confirm pages"` |
| 246 | `{content.hostedPages` |
| 253 | `{content.hostedPages && (` |
| 255 | `brand={content.hostedPages}` |
| 266 | `<aside className="min-w-0 lg:sticky lg:top-4 lg:self-start" aria-label="Live preview">` |
| 277 | `readOnly,` |
| 282 | `readOnly: boolean;` |
| 285 | `const [draft, setDraft] = useState('');` |
| 286 | `const [local, setLocal] = useState<string \| null>(null);` |
| 310 | `<Field label="Traits" hint="Trait names: a letter, then letters, digits or underscores. Up to 20." error={error ?? local}>` |
| 331 | `<Button variant="secondary" icon={<Plus size={14} />} onClick={add} disabled={readOnly \|\| !draft.trim() \|\| value.length >= 20}>` |
| 332 | `Add` |
| 339 | `<ul className="flex flex-wrap gap-1.5" aria-label="Traits kept by this form">` |
| 344 | `label={′Remove trait ${trait}′}` |
| 369 | `const [text, setText] = useState(() => value.join('\n'));` |
| 406 | `label="Allowed sites"` |
| 407 | `hint="One origin per line, such as https://example.com. Leave empty to allow any site."` |
| 433 | `label: string;` |
| 443 | `<Field label={label} hint={hint} required={required} error={error ?? local}>` |
| 483 | `const [accentError, setAccentError] = useState<string \| null>(null);` |
| 484 | `const [siteUrlError, setSiteUrlError] = useState<string \| null>(null);` |
| 485 | `const [logoUrlError, setLogoUrlError] = useState<string \| null>(null);` |
| 489 | `<Field label="Site name" hint="Shown at the top when there is no logo, and in “Back to …”." error={errors['hostedPages.siteName']}>` |
| 499 | `label="Site URL"` |
| 500 | `hint="Where “Back to …” points. Use https, or http on localhost."` |
| 521 | `label="Logo URL"` |
| 522 | `hint="An https URL, for example an asset public URL. Optional."` |
| 544 | `label="Accent colour"` |
| 545 | `hint="The primary button and links, e.g. #1d4ed8."` |
| 551 | `aria-label="Accent colour picker"` |
| 577 | `{COPY_DEFAULTS.map((f) => (` |
| 580 | `label={f.label}` |
| 581 | `hint={′Default: ${f.hint.replace(/^Default: /, '')}′}` |
| 599 | `const preview = useApi(() => api.call('hostedPages.preview', { page: 'confirm', formId }), [formId, savedVersion]);` |
| 603 | `{preview.loading ? (` |
| 604 | `<LoadingBlock lines={5} label="Rendering the confirm page" />` |
| 605 | `) : preview.error ? (` |
| 606 | `<Alert tone="bad" title="Couldn't render the confirm page" onRetry={preview.reload}>` |
| 607 | `{preview.error}` |
| 611 | `title="Confirm page preview"` |


### apps/web/src/features/artifacts/SegmentEditor.tsx

[Baseline source](../../../apps/web/src/features/artifacts/SegmentEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useMemo, useRef, useState } from 'react';` |
| 55 | `[key: string]: unknown;` |
| 58 | `const OPERATORS: { value: Op; label: string }[] = [` |
| 59 | `{ value: 'eq', label: 'is' },` |
| 60 | `{ value: 'neq', label: 'is not' },` |
| 61 | `{ value: 'in', label: 'is one of' },` |
| 62 | `{ value: 'gt', label: 'is greater than' },` |
| 63 | `{ value: 'gte', label: 'is at least' },` |
| 64 | `{ value: 'lt', label: 'is less than' },` |
| 65 | `{ value: 'lte', label: 'is at most' },` |
| 66 | `{ value: 'exists', label: 'is set' },` |
| 67 | `{ value: 'not_exists', label: 'is not set' },` |
| 68 | `{ value: 'contains', label: 'contains' },` |
| 72 | `{ value: 'P1D', label: '1 day' },` |
| 73 | `{ value: 'P7D', label: '7 days' },` |
| 74 | `{ value: 'P14D', label: '14 days' },` |
| 75 | `{ value: 'P30D', label: '30 days' },` |
| 76 | `{ value: 'P90D', label: '90 days' },` |
| 81 | `export function SegmentEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<SegmentContent>) {` |
| 83 | `const group = useMemo(() => groupOf(content.condition), [content.condition]);` |
| 85 | `const mode = content.mode ?? 'dynamic';` |
| 92 | `<Field label="Description" hint="For the team; people in the segment never see it." error={errors.description}>` |
| 96 | `value={content.description ?? ''}` |
| 97 | `readOnly={readOnly}` |
| 130 | `<section aria-label="Condition" className="space-y-2">` |
| 135 | `<GroupEditor mode={group.mode} rows={group.rows} onChange={emit} depth={1} readOnly={readOnly} artifactId={artifact.id} />` |
| 141 | `<summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-fg-2 select-none">JSON</summary>` |
| 155 | `readOnly,` |
| 162 | `readOnly: boolean;` |
| 179 | `aria-label={depth > 1 ? 'Match all or any of the conditions in this group' : 'Match all or any of these conditions'}` |
| 181 | `disabled={readOnly}` |
| 184 | `<option value="all">Match all of these</option>` |
| 185 | `<option value="any">Match any of these</option>` |
| 207 | `<Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => add('trait')} disabled={readOnly}>` |
| 208 | `Add row` |
| 215 | `disabled={readOnly \|\| depth >= 3}` |
| 216 | `title={depth >= 3 ? 'Groups can be nested three levels deep.' : undefined}` |
| 218 | `Add group` |
| 259 | `aria-label={′Kind of condition ${n}′}` |
| 264 | `<option value="trait">Trait</option>` |
| 265 | `<option value="event">Did event</option>` |
| 266 | `<option value="consent">Allows purpose</option>` |
| 267 | `<option value="segment">In segment</option>` |
| 268 | `<option value="not">Not</option>` |
| 269 | `<option value="group" disabled={depth >= 3}>` |
| 270 | `Group` |
| 275 | `label={′Remove condition ${n}′}` |
| 285 | `{kind === 'trait' && <TraitRow c={condition as TraitCondition} onChange={onChange} index={n} readOnly={readOnly} />}` |
| 286 | `{kind === 'event' && <EventRow c={condition as EventCondition} onChange={onChange} index={n} readOnly={readOnly} />}` |
| 287 | `{kind === 'consent' && <ConsentRow c={condition as ConsentCondition} onChange={onChange} index={n} readOnly={readOnly} />}` |
| 289 | `<SegmentRow c={condition as SegmentRefCondition} onChange={onChange} index={n} readOnly={readOnly} artifactId={artifactId} />` |
| 376 | `const [text, setText] = useState(() => valueText(c.value));` |
| 395 | `<Field label={′Trait name, condition ${index}′} hideLabel>` |
| 396 | `<Input value={c.trait} readOnly={readOnly} placeholder="loyaltyTier" onChange={(e) => onChange({ ...c, trait: e.target.value })} />` |
| 398 | `<Field label={′Operator, condition ${index}′} hideLabel>` |
| 399 | `<Select value={c.op} disabled={readOnly} onChange={(e) => setOp(e.target.value as Op)}>` |
| 401 | `<option key={o.value} value={o.value}>` |
| 408 | `<Field label={′Value, condition ${index}′} hideLabel hint={c.op === 'in' ? 'Separate values with commas.' : undefined}>` |
| 457 | `<Field label={′Event name, condition ${index}′} hideLabel>` |
| 465 | `<Field label={′At least how many times, condition ${index}′} hideLabel unit="times">` |
| 476 | `<Field label={′In the last, condition ${index}′} hideLabel>` |
| 477 | `<Select value={c.within ?? ''} disabled={readOnly} onChange={(e) => setWithin(e.target.value)}>` |
| 478 | `<option value="">Any time</option>` |
| 480 | `<option key={d.value} value={d.value}>` |
| 484 | `{c.within && !DURATIONS.some((d) => d.value === c.within) && <option value={c.within}>{c.within}</option>}` |
| 502 | `const purposes = useApi(() => api.call('purposes.list', {}), []);` |
| 507 | `<Field label={′Purpose, condition ${index}′} hideLabel>` |
| 510 | `disabled={readOnly \|\| purposes.loading}` |
| 511 | `aria-label={′Purpose, condition ${index}′}` |
| 514 | `<option value="">` |
| 515 | `{purposes.loading ? 'Loading purposes…' : purposes.error ? ′Couldn't load: ${purposes.error}′ : 'Choose a purpose…'}` |
| 518 | `<option key={p.key} value={p.key}>` |
| 522 | `{missing && <option value={c.consent}>{c.consent} (not found)</option>}` |
| 542 | `<SegmentPicker value={c.segment} onChange={(segment) => onChange({ segment })} exclude={artifactId} disabled={readOnly} index={index} />` |
| 564 | `<Field label={′Segment, condition ${index}′} hideLabel>` |
| 567 | `disabled={disabled \|\| list.loading}` |
| 568 | `aria-label={′Segment, condition ${index}′}` |
| 571 | `<option value="">{list.loading ? 'Loading…' : list.error ? ′Couldn't load: ${list.error}′ : 'Choose a segment…'}</option>` |
| 572 | `{!known && value && <option value={value}>{value} (this segment or not found)</option>}` |
| 574 | `<option key={a.id} value={a.id}>` |
| 586 | `const allowed = can('profiles:read');` |
| 587 | `const [size, setSize] = useState<{ loading: boolean; count?: number; error?: string }>({ loading: true });` |
| 592 | `setSize({ loading: true });` |
| 595 | `const r = await api.call('segments.preview', { condition });` |
| 596 | `if (!cancelled) setSize({ loading: false, count: r.count });` |
| 598 | `if (!cancelled) setSize({ loading: false, error: errText(e) });` |
| 614 | `) : size.loading ? (` |
| 616 | `) : size.error ? (` |
| 617 | `<p className="text-[13px] text-bad">{size.error}</p>` |


### apps/web/src/features/artifacts/ListAudiencePanel.tsx

[Baseline source](../../../apps/web/src/features/artifacts/ListAudiencePanel.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useMemo, useState } from 'react';` |
| 20 | `const mayWrite = can('profiles:write');` |
| 21 | `const maySeeEmail = can('profiles:pii');` |
| 22 | `const [after, setAfter] = useState<string \| undefined>(undefined);` |
| 23 | `const [adding, setAdding] = useState(false);` |
| 24 | `const [importing, setImporting] = useState(false);` |
| 25 | `const members = useApi(() => api.call('segments.members', { artifactId, limit: 50, after }), [artifactId, after]);` |
| 26 | `const imports = useApi(() => api.call('audiences.imports', { segmentId: artifactId, limit: 10 }), [artifactId]);` |
| 27 | `const [busy, setBusy] = useState<string \| null>(null);` |
| 32 | `const r = await api.call('audiences.remove', { segmentId: artifactId, profileIds: [m.profileId] });` |
| 36 | `toast.error(errText(e));` |
| 45 | `const r = await api.call('audiences.refreshSnapshot', { segmentId: artifactId });` |
| 58 | `Membership is not consent. Sends to this audience still skip people who have not consented to the purpose, who are suppressed, or` |
| 62 | `{content.mode === 'snapshot' && (` |
| 67 | `Copied from {content.sourceSegment ?? 'a segment'}` |
| 68 | `{content.snapshotVersion ? ′ at v${content.snapshotVersion}′ : ''}` |
| 69 | `{content.snapshotAt ? ′ on ${new Date(content.snapshotAt).toLocaleString()}′ : ''}. It stays fixed until it is refreshed.` |
| 77 | `loading={busy === 'snapshot'}` |
| 80 | `Refresh from source` |
| 92 | `Import CSV` |
| 97 | `Add people` |
| 104 | `loading={members.loading}` |
| 105 | `error={members.error}` |
| 107 | `isEmpty={!members.loading && !members.error && (members.data?.members.length ?? 0) === 0}` |
| 110 | `<Table label="Audience members">` |
| 113 | `<Th>Person</Th>` |
| 114 | `{maySeeEmail && <Th>E-mail</Th>}` |
| 115 | `<Th>Added</Th>` |
| 116 | `<Th className="w-10" />` |
| 134 | `aria-label={′Remove ${m.profileId}′}` |
| 135 | `loading={busy === m.profileId}` |
| 148 | `First page` |
| 156 | `Next page` |
| 160 | `<section aria-label="Import history" className="space-y-2">` |
| 162 | `{imports.error ? (` |
| 163 | `<p className="text-[12px] text-bad">{imports.error}</p>` |
| 164 | `) : !imports.loading && !(imports.data?.imports.length ?? 0) ? (` |
| 208 | `const [idType, setIdType] = useState<'email' \| 'user_id' \| 'profile_id'>('email');` |
| 209 | `const [text, setText] = useState('');` |
| 210 | `const [busy, setBusy] = useState(false);` |
| 211 | `const [error, setError] = useState<string \| null>(null);` |
| 212 | `const [unmatched, setUnmatched] = useState<AddUnmatched[]>([]);` |
| 228 | `const r = await api.call('audiences.add', {` |
| 252 | `title="Add people"` |
| 258 | `<Button variant="primary" loading={busy} onClick={() => void submit()}>` |
| 259 | `Add` |
| 265 | `<Field label="Identify people by">` |
| 267 | `<option value="email">E-mail address</option>` |
| 268 | `<option value="user_id">User id</option>` |
| 269 | `<option value="profile_id">Profile id</option>` |
| 272 | `<Field label="People" hint="One per line. Up to 1,000. Adding someone twice changes nothing.">` |
| 299 | `const [fileName, setFileName] = useState('');` |
| 300 | `const [csv, setCsv] = useState('');` |
| 301 | `const [column, setColumn] = useState('');` |
| 303 | `const [preview, setPreview] = useState<ImportResult \| null>(null);` |
| 324 | `const r = await api.call('audiences.import', { segmentId: artifactId, csv, column, idType, fileName, dryRun });` |
| 341 | `title="Import a CSV"` |
| 346 | `Close` |
| 349 | `<Button variant="primary" loading={busy} onClick={() => void run(false)}>` |
| 354 | `<Button variant="primary" loading={busy} disabled={!csv} onClick={() => void run(true)}>` |
| 355 | `Preview matches` |
| 362 | `<Field label="CSV file" hint="Up to 5 MB, with a header row. UTF-8, comma, semicolon or tab.">` |
| 369 | `<Field label="Column with the identifier">` |
| 377 | `<option value="">Choose a column…</option>` |
| 380 | `<option key={′${h}-${i}′} value={h}>` |
| 468 | `[key: string]: unknown;` |


### apps/web/src/features/artifacts/ExperienceResults.tsx

[Baseline source](../../../apps/web/src/features/artifacts/ExperienceResults.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 32 | `const results = useApi(() => api.call('experiences.results', { artifactId: artifact.id }), [artifact.id], { skip: !published });` |
| 35 | `<EmptyState title="No results yet">` |
| 36 | `Publish the experience to start collecting exposures and conversions. Results appear here as visitors see the variants.` |
| 39 | `if (results.loading) return <LoadingBlock lines={5} />;` |
| 40 | `if (results.error \|\| !results.data)` |
| 42 | `<Alert tone="bad" title="Couldn't load the results" onRetry={results.reload}>` |
| 43 | `{results.error ?? 'The server returned no results.'}` |
| 64 | `Refresh` |
| 71 | `<EmptyState title="No exposures yet" compact>` |
| 72 | `When visitors see a variant, its exposures show here. Events arrive within a minute or two.` |
| 76 | `<Table label="Experiment results">` |
| 79 | `<Th>Variant</Th>` |
| 80 | `<Th align="right">Exposed</Th>` |
| 81 | `<Th align="right">Converted</Th>` |
| 82 | `<Th align="right">Rate</Th>` |
| 83 | `<Th align="right">Lift vs control</Th>` |
| 84 | `<Th align="right">{significance}</Th>` |
| 85 | `<Th align="right" className="hidden lg:table-cell">` |
| 106 | `title={v.ci95 ? ′95% interval for the difference in rate: ${points(v.ci95[0])} to ${points(v.ci95[1])}′ : undefined}` |
| 130 | `title={′Expected loss from choosing this variant: ${points(v.expectedLoss)}′}` |
| 141 | `<Alert tone="info" title="What the numbers mean">` |


### apps/web/src/features/artifacts/ExperienceEditor.tsx

[Baseline source](../../../apps/web/src/features/artifacts/ExperienceEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useState } from 'react';` |
| 18 | `[key: string]: unknown;` |
| 49 | `goal?: { event?: string; [key: string]: unknown };` |
| 134 | `readOnly,` |
| 136 | `label: string;` |
| 145 | `readOnly?: boolean;` |
| 147 | `const [text, setText] = useState(String(value));` |
| 153 | `<Field label={label} unit={unit} hint={hint} error={error}>` |
| 161 | `readOnly={readOnly}` |
| 176 | `export function ExperienceEditor({ content, onChange, readOnly, errors, warnings }: EditorProps<ExperienceContent>) {` |
| 178 | `const variants = content.variants ?? [];` |
| 179 | `const trigger = content.trigger ?? { type: 'immediate' as TriggerType };` |
| 180 | `const analysis = content.analysis ?? { method: 'sequential' as AnalysisMethod, alpha: 0.05, threshold: 0.95 };` |
| 182 | `const targeting = targetingKind(content.targeting);` |
| 187 | `<Alert tone="warn" title="The schema still needs">` |
| 196 | `<FieldGroup legend="Where it shows">` |
| 199 | `label="Placement"` |
| 200 | `hint="The element on your site marked data-am-placement=&quot;…&quot;. Lowercase letters, digits, _ and -."` |
| 205 | `value={content.placement ?? ''}` |
| 213 | `label="Priority"` |
| 214 | `value={content.priority ?? 100}` |
| 218 | `hint="Higher wins when several target the placement."` |
| 224 | `<Field label="Description" hint="For the team; visitors never see it." error={errors.description}>` |
| 228 | `value={content.description ?? ''}` |
| 235 | `<FieldGroup legend="When it shows">` |
| 236 | `<Field label="Trigger" error={errors['trigger.type']}>` |
| 239 | `disabled={readOnly}` |
| 243 | `<option key={t} value={t}>` |
| 251 | `label={trigger.type === 'scroll' ? 'Scroll' : 'Wait'}` |
| 257 | `hint={trigger.type === 'scroll' ? 'Share of the page scrolled past.' : 'Seconds on the page before it shows.'}` |
| 266 | `legend="Who sees it"` |
| 267 | `hint="Traits, segments and session conditions need web_personalization consent; page, referrer, UTM and device do not."` |
| 269 | `<Field label="Targeting" error={errors.targeting}>` |
| 283 | `<option value="everyone">Everyone who sees the placement</option>` |
| 284 | `<option value="segment">People in a segment</option>` |
| 285 | `<option value="custom">A custom condition</option>` |
| 290 | `label="Segment"` |
| 291 | `hint="Members of a published segment; evaluated from the segment snapshot."` |
| 296 | `value={typeof content.targeting?.segment === 'string' ? content.targeting.segment : undefined}` |
| 304 | `label="Targeting condition (JSON)"` |
| 305 | `hint="The decision condition, e.g. {&quot;page&quot;:{&quot;pathPrefix&quot;:&quot;/blog&quot;}} or {&quot;device&quot;:&quot;mobile&quot;}."` |
| 306 | `value={content.targeting ?? { page: {} }}` |
| 314 | `<FieldGroup legend="Variants" hint="Up to five. Weights are relative shares; at least one must be above 0.">` |
| 323 | `{!readOnly && (` |
| 326 | `label={′Move variant ${n} up′}` |
| 333 | `label={′Move variant ${n} down′}` |
| 340 | `label={′Remove variant ${n}′}` |
| 346 | `title={variants.length <= 1 ? 'An experience needs at least one variant.' : undefined}` |
| 352 | `<Field label={′Name of variant ${n}′} error={errors[′variants.${i}.name′]} hideLabel={false}>` |
| 361 | `<Field label={′Id of variant ${n}′} hint="Lowercase letters, digits and _, up to 32." error={errors[′variants.${i}.id′]}>` |
| 371 | `label={′Weight of variant ${n}′}` |
| 382 | `<Field label={′Content for variant ${n}′} error={errors[′variants.${i}.content′]}>` |
| 386 | `aria-label={′Content kind for variant ${n}′}` |
| 395 | `<option value="html">HTML for the placement</option>` |
| 396 | `<option value="json">JSON data for the site to render</option>` |
| 401 | `label={′HTML for variant ${n}′}` |
| 402 | `hint="Scripts and event handlers are removed by the SDK."` |
| 403 | `error={errors[′variants.${i}.content.html′]}` |
| 420 | `label={′JSON data for variant ${n}′}` |
| 421 | `hint="Data for a site that renders the placement itself."` |
| 438 | `{!readOnly && variants.length < 5 && (` |
| 440 | `Add variant` |
| 453 | `label="Holdout"` |
| 454 | `value={content.holdoutPercent ?? 0}` |
| 459 | `hint="Eligible visitors who see nothing, as a control group."` |
| 467 | `<FieldGroup legend="Measurement" hint="Optional: the event that counts as a conversion, and how results call a winner.">` |
| 470 | `label="Goal event"` |
| 471 | `hint="For example Purchase or Newsletter Signup. Leave empty for no conversion goal."` |
| 475 | `value={content.goal?.event ?? ''}` |
| 481 | `if (event) set({ goal: { ...content.goal, event } });` |
| 491 | `<Field label="Analysis" error={errors['analysis.method']}>` |
| 498 | `<option key={m} value={m}>` |
| 506 | `label="Alpha"` |
| 511 | `hint={analysis.method === 'bayesian' ? 'Not used by the Bayesian method.' : 'The false-positive rate to accept.'}` |
| 517 | `label="Threshold"` |
| 522 | `hint="Bayesian method: probability needed to call a winner."` |


### apps/web/src/features/artifacts/PurposesEditor.tsx

[Baseline source](../../../apps/web/src/features/artifacts/PurposesEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 18 | `[key: string]: unknown;` |
| 22 | `key: string;` |
| 53 | `const CHANNELS: { value: Channel; label: string }[] = [` |
| 54 | `{ value: 'email', label: 'E-mail' },` |
| 55 | `{ value: 'web', label: 'Website' },` |
| 56 | `{ value: 'sms', label: 'SMS' },` |
| 57 | `{ value: 'push', label: 'Push' },` |
| 58 | `{ value: 'webhook', label: 'Webhook' },` |
| 69 | `{ key: ′purpose_${n}′, name: 'New purpose', description: '', basis: 'consent', channels: [], requiresDoubleOptIn: false },` |
| 90 | `export function isKeyLocked(key: string, inUse: Iterable<string>): boolean {` |
| 103 | `topics: [...topics, { key: ′topic_${n}′, name: ′Topic ${n}′, description: '', default: 'subscribed' }],` |
| 116 | `export function topicsOf(purposes: { key: string; topics?: Topic[] }[], purpose: string \| undefined): Topic[] {` |
| 120 | `export function PurposesEditor({ content, onChange, readOnly, errors, warnings }: EditorProps<PurposesContent>) {` |
| 122 | `const purposes = content.purposes ?? [];` |
| 123 | `const inForce = useApi(() => api.call('purposes.list', {}), []);` |
| 129 | `{inForce.error && (` |
| 130 | `<Alert tone="bad" title="Couldn't load the purposes in force" onRetry={inForce.reload}>` |
| 131 | `Keys stay locked until they load, so a rename cannot break forms or journeys. {inForce.error}` |
| 135 | `<Alert tone="warn" title="The schema still needs">` |
| 154 | `<section key={i} className="space-y-3 rounded-lg border border-line p-4" aria-label={′Purpose ${n}′}>` |
| 158 | `<span className="text-[12px] text-muted" title="Forms, journeys or messages refer to this key.">` |
| 162 | `{!readOnly && (` |
| 165 | `label={′Remove purpose ${n}′}` |
| 171 | `title={purposes.length <= 1 ? 'At least one purpose is needed.' : undefined}` |
| 179 | `label={′Key of purpose ${n}′}` |
| 180 | `hint={` |
| 192 | `readOnly={readOnly \|\| locked}` |
| 195 | `onChange={(e) => set({ purposes: updatePurpose(purposes, i, { key: e.target.value }) })}` |
| 199 | `label={′Name of purpose ${n}′}` |
| 200 | `hint="Shown to people in consent banners and preferences."` |
| 206 | `readOnly={readOnly}` |
| 215 | `label={′Description of purpose ${n}′}` |
| 216 | `hint="Shown next to the name, in plain words, e.g. what people get and how often."` |
| 229 | `<Field label={′Lawful basis of purpose ${n}′} error={errors[′purposes.${i}.basis′]}>` |
| 232 | `disabled={readOnly}` |
| 236 | `<option key={b} value={b}>` |
| 246 | `label={′Double opt-in for purpose ${n}′}` |
| 261 | `label={c.label}` |
| 285 | `<Field label={′Topic key ${j + 1}′} error={errors[′purposes.${i}.topics.${j}.key′]} required>` |
| 292 | `onChange={(e) => set({ purposes: updatePurpose(purposes, i, updateTopic(purpose, j, { key: e.target.value })) })}` |
| 295 | `<Field label={′Topic name ${j + 1}′} error={errors[′purposes.${i}.topics.${j}.name′]} required>` |
| 304 | `<Field label={′Default ${j + 1}′} hint="Until the person chooses." error={errors[′purposes.${i}.topics.${j}.default′]}>` |
| 318 | `<option value="subscribed">Subscribed</option>` |
| 319 | `<option value="unsubscribed">Unsubscribed</option>` |
| 324 | `label={′Remove topic ${j + 1} from purpose ${n}′}` |
| 332 | `<Field label={′Topic description ${j + 1}′} error={errors[′purposes.${i}.topics.${j}.description′]}>` |
| 345 | `{!readOnly && (purpose.topics ?? []).length < 20 && (` |
| 352 | `Add topic` |
| 366 | `<Field label={′LIA assessment for purpose ${n}′} error={errors[′purposes.${i}.lia.assessment′]}>` |
| 382 | `<Field label={′LIA owner for purpose ${n}′} error={errors[′purposes.${i}.lia.owner′]}>` |
| 402 | `label={′LIA review date for purpose ${n}′}` |
| 403 | `hint="The date the assessment is next reviewed."` |
| 426 | `{!readOnly && purposes.length < 50 && (` |
| 428 | `Add purpose` |


### apps/web/src/features/content/TopicsTable.tsx

[Baseline source](../../../apps/web/src/features/content/TopicsTable.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 11 | `export type TopicRow = Out<'content.topics.list'>['topics'][number];` |
| 13 | `export const TOPIC_STATUS: Record<string, { label: string; tone: Tone }> = {` |
| 14 | `idea: { label: 'Idea', tone: 'neutral' },` |
| 15 | `scored: { label: 'Scored', tone: 'info' },` |
| 16 | `brief: { label: 'Brief', tone: 'warn' },` |
| 17 | `approved: { label: 'Approved', tone: 'good' },` |
| 18 | `drafting: { label: 'Drafting', tone: 'info' },` |
| 19 | `published: { label: 'Published', tone: 'good' },` |
| 20 | `archived: { label: 'Archived', tone: 'neutral' },` |
| 23 | `export const topicStatus = (status: string) => TOPIC_STATUS[status] ?? { label: status, tone: 'neutral' as Tone };` |
| 58 | `<EmptyState icon={<FileText size={20} />} title="No topics in this view">` |
| 59 | `A topic starts as an idea, is scored by its signals, and becomes a brief when it is worth writing. Adjust the filters, or add the` |
| 64 | `<Table label="Editorial topics">` |
| 67 | `<Th>Topic</Th>` |
| 68 | `<Th>Status</Th>` |
| 69 | `<Th>Score</Th>` |
| 70 | `<Th className="hidden lg:table-cell">Why it surfaced</Th>` |
| 71 | `<Th className="hidden md:table-cell">Owner</Th>` |
| 72 | `<Th className="hidden md:table-cell">Target</Th>` |
| 73 | `<Th>` |
| 118 | `Brief` |
| 126 | `aria-label={′Archive ${topic.title}′}` |
| 127 | `title="Archive"` |


## C · #526


### apps/web/src/pages/design/BrandPage.tsx

[Baseline source](../../../apps/web/src/pages/design/BrandPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 17 | `const list = useApi(() => api.call('artifacts.list', { type: 'brand', limit: 1 }), []);` |
| 18 | `const [busy, setBusy] = useState(false);` |
| 19 | `const [error, setError] = useState<string \| null>(null);` |
| 34 | `loading={list.loading}` |
| 35 | `error={list.error ?? error}` |
| 37 | `canCreate={can('artifacts:write')}` |
| 42 | `await api.call('artifacts.create', { type: 'brand', name: 'Brand', content: { siteName: workspace.name } });` |
| 55 | `loading,` |
| 62 | `loading: boolean;` |
| 69 | `useCrumbs([{ label: 'Brand' }]);` |
| 70 | `if (loading) return <LoadingBlock lines={6} />;` |
| 73 | `<PageHeader title="Brand" description="Name, logo, colours and wording of the pages subscribers see." />` |
| 80 | `title="No brand yet"` |
| 83 | `<Button variant="primary" icon={<Plus size={15} />} loading={busy} onClick={onCreate}>` |
| 84 | `Set up the brand` |
| 89 | `Until you set one up, confirm and unsubscribe pages use a plain neutral look.` |
| 98 | `const BRAND_TAB_ITEMS: { key: BrandTab; label: string }[] = [` |
| 99 | `{ key: 'brand', label: 'Brand' },` |
| 100 | `{ key: 'subscriber-pages', label: 'Subscriber pages' },` |
| 106 | `useCrumbs([{ label: active === 'subscriber-pages' ? 'Subscriber pages' : 'Brand' }]);` |
| 112 | `This tab is unavailable.` |
| 115 | `<Tabs items={BRAND_TAB_ITEMS} value={active} onChange={select} label="Brand">` |


### apps/web/src/pages/design/HostedPagesPage.tsx

[Baseline source](../../../apps/web/src/pages/design/HostedPagesPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useState } from 'react';` |
| 13 | `useCrumbs([{ label: 'Hosted pages' }]);` |
| 15 | `const archive = useApi(() => api.call('archive.issues', {}), []);` |
| 17 | `const [formId, setFormId] = useState('');` |
| 21 | `title="Hosted pages"` |
| 25 | `Edit brand` |
| 34 | `<Card title="Preview as" padded>` |
| 35 | `<Field label="Form" hint="A form's own look (Forms → form → Hosted pages) applies to its confirm and expired pages.">` |
| 37 | `<option value="">Workspace brand</option>` |
| 39 | `<option key={f.id} value={f.id}>` |
| 46 | `<Card title="Newsletter archive" padded>` |
| 52 | `Open the live archive` |
| 68 | `<Card title="Where they appear" padded>` |


### apps/web/src/pages/design/TemplatePage.tsx

[Baseline source](../../../apps/web/src/pages/design/TemplatePage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 13 | `crumbs={[{ label: 'E-mail templates', to: '/content/templates' }]}` |
| 24 | `const [busy, setBusy] = useState(false);` |
| 25 | `if (!can('artifacts:write')) return null;` |
| 29 | `loading={busy}` |
| 30 | `title="Send a [Test] copy of the saved version to your own address"` |
| 34 | `const r = await api.call('templates.sendTest', { artifactId: id, version });` |
| 37 | `toast.error(′The test was not sent: ${errText(e)}′);` |
| 43 | `Send me a test` |


### apps/web/src/pages/design/TemplatesPage.tsx

[Baseline source](../../../apps/web/src/pages/design/TemplatesPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 25 | `title="E-mail templates"` |
| 27 | `emptyTitle="No e-mail templates yet"` |
| 28 | `emptyText="Create one for each newsletter issue or automated e-mail. Agents can draft templates too; you review them before they go out."` |
| 30 | `label: 'New template',` |
| 40 | `const TEMPLATE_TAB_ITEMS: { key: TemplateTab; label: string }[] = [` |
| 41 | `{ key: 'templates', label: 'Templates' },` |
| 42 | `{ key: 'blocks', label: 'Blocks' },` |
| 48 | `useCrumbs([{ label: active === 'blocks' ? 'Blocks' : 'E-mail templates' }]);` |
| 54 | `This tab is unavailable.` |
| 57 | `<Tabs items={TEMPLATE_TAB_ITEMS} value={active} onChange={select} label="Templates">` |


### apps/web/src/pages/design/AssetsPage.tsx

[Baseline source](../../../apps/web/src/pages/design/AssetsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useRef, useState } from 'react';` |
| 12 | `Alert,` |
| 13 | `Button,` |
| 14 | `CodeView,` |
| 16 | `Drawer,` |
| 17 | `EmptyState,` |
| 18 | `Field,` |
| 20 | `Input,` |
| 21 | `LoadingBlock,` |
| 22 | `Meta,` |
| 23 | `PageHeader,` |
| 24 | `Select,` |
| 25 | `Skeleton,` |
| 26 | `StatusPill,` |
| 27 | `Textarea,` |
| 35 | `useCrumbs([{ label: 'Assets' }]);` |
| 38 | `const [q, setQ] = useState('');` |
| 39 | `const [kind, setKind] = useState<'' \| 'image' \| 'file'>('');` |
| 40 | `const list = useApi(() => api.call('assets.list', { query: q \|\| undefined, kind: kind \|\| undefined, limit: 200 }), [q, kind]);` |
| 41 | `const [open, setOpen] = useState<Asset \| null>(null);` |
| 42 | `const [uploading, setUploading] = useState<string[]>([]);` |
| 43 | `const [errors, setErrors] = useState<string[]>([]);` |
| 44 | `const [dragging, setDragging] = useState(false);` |
| 46 | `const canWrite = can('artifacts:write');` |
| 51 | `setUploading(files.map((f) => f.name));` |
| 61 | `setUploading((u) => u.filter((n) => n !== f.name));` |
| 70 | `// biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is a mouse enhancement; uploading also works through the Upload button` |
| 91 | `title="Assets"` |
| 107 | `<Button variant="primary" icon={<Upload size={15} />} onClick={() => input.current?.click()} loading={uploading.length > 0}>` |
| 108 | `Upload` |
| 118 | `aria-label="Search assets"` |
| 125 | `<Select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-auto">` |
| 126 | `<option value="">Images and PDFs</option>` |
| 127 | `<option value="image">Images</option>` |
| 128 | `<option value="file">PDFs</option>` |
| 133 | `<Alert tone="bad" title="Some files were not uploaded" className="mb-4">` |
| 141 | `{uploading.length > 0 && (` |
| 145 | `aria-label={′Uploading ${uploading.length} files′}` |
| 147 | `{uploading.map((n) => (` |
| 155 | `{list.loading ? (` |
| 157 | `) : list.error ? (` |
| 158 | `<Alert tone="bad" title="Couldn't load assets" onRetry={list.reload}>` |
| 159 | `{list.error}` |
| 166 | `title={q \|\| kind ? 'Nothing matches' : 'No assets yet'}` |
| 192 | `const a = useApi(() => api.call('assets.get', { id }), [id]);` |
| 193 | `const [name, setName] = useState<string \| null>(null);` |
| 194 | `const [alt, setAlt] = useState<string \| null>(null);` |
| 195 | `const [busy, setBusy] = useState(false);` |
| 196 | `const [error, setError] = useState<string \| null>(null);` |
| 206 | `await api.call('assets.update', {` |
| 226 | `title: ′Delete “${asset.name}”?′,` |
| 251 | `await api.call('assets.delete', { id: asset.id, force: used > 0 });` |
| 256 | `toast.error(errText(e));` |
| 265 | `title={asset?.name ?? 'Asset'}` |
| 272 | `Delete` |
| 274 | `<Button variant="primary" className="ml-auto" disabled={!dirty} loading={busy} onClick={save}>` |
| 275 | `Save changes` |
| 281 | `{a.loading ? (` |
| 283 | `) : a.error ? (` |
| 286 | `{a.error}` |
| 294 | `<CodeView value={asset.url} label="Public URL" />` |
| 295 | `<Field label="Name" hint="For finding it here; not shown to recipients.">` |
| 296 | `<Input value={name ?? asset.name} onChange={(e) => setName(e.target.value)} readOnly={!canWrite} maxLength={120} />` |
| 300 | `label="Alt text"` |
| 301 | `hint="Read aloud by screen readers and shown when images are blocked. Describe what the image shows; leave empty only for decoration."` |
| 307 | `readOnly={!canWrite}` |


### apps/web/src/pages/design/BlockPage.tsx

[Baseline source](../../../apps/web/src/pages/design/BlockPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 9 | `crumbs={[{ label: 'Blocks', to: '/content/templates?tab=blocks' }]}` |
| 12 | `extraTabs={[{ key: 'usage', label: 'Used by', render: (a) => <BlockUsage artifactId={a.id} /> }]}` |


### apps/web/src/pages/design/BlocksPage.tsx

[Baseline source](../../../apps/web/src/pages/design/BlocksPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 16 | `title="Blocks"` |
| 18 | `emptyTitle="No blocks yet"` |
| 19 | `emptyText="Create a header or footer once and reuse it in every issue. Templates keep the tag, so a later block version is used the next time an e-mail is rendered."` |
| 21 | `label: 'New block',` |
| 24 | `<Field label="Category" hint="Header, footer, section, call to action, legal or other." error={errors.category} required>` |
| 27 | `<option key={value} value={value}>` |
| 38 | `{ key: 'title', label: 'Title', type: 'text', default: 'This week' },` |
| 39 | `{ key: 'body', label: 'Body', type: 'html', default: '<p>Your text here.</p>' },` |


### apps/web/src/pages/build/RecipesPage.tsx

[Baseline source](../../../apps/web/src/pages/build/RecipesPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useCallback, useEffect, useState } from 'react';` |
| 26 | `useCrumbs([{ label: embedded ? 'Starters' : 'Recipes' }]);` |
| 28 | `const [list, setList] = useState<RecipeSummary[]>([]);` |
| 29 | `const [selected, setSelected] = useState<string \| null>(null);` |
| 30 | `const [recipe, setRecipe] = useState<Recipe \| null>(null);` |
| 31 | `const [values, setValues] = useState<Values>({});` |
| 32 | `const [preview, setPreview] = useState<Preview \| null>(null);` |
| 33 | `const [installed, setInstalled] = useState<Installed \| null>(null);` |
| 34 | `const [loading, setLoading] = useState(true);` |
| 35 | `const [checking, setChecking] = useState(false);` |
| 36 | `const [installing, setInstalling] = useState(false);` |
| 37 | `const [error, setError] = useState<string \| null>(null);` |
| 38 | `const canWrite = can('artifacts:write');` |
| 43 | `.call('recipes.list', {})` |
| 62 | `const got = await api.call('recipes.get', { recipeId });` |
| 66 | `setPreview(await api.call('recipes.preview', { recipeId, params: initial }));` |
| 76 | `const setParam = (key: string, value: ParamValue \| undefined) => {` |
| 91 | `setPreview(await api.call('recipes.preview', { recipeId: recipe.id, params: values }));` |
| 104 | `const out = await api.call('recipes.install', { recipeId: recipe.id, params: values });` |
| 118 | `title="Recipes"` |
| 130 | `<Alert tone="bad" title="That did not work" className="mb-4">` |
| 136 | `<Card title="Gallery" description="Pick a loop to preview." padded={false}>` |
| 137 | `{loading && <p className="px-4 py-3 text-[13px] text-muted">Loading recipes…</p>}` |
| 162 | `{!selected && !loading ? (` |
| 163 | `<EmptyState title="No recipes">This server ships no recipes.</EmptyState>` |
| 166 | `<Card title={recipe.title} description={recipe.description}>` |
| 177 | `label={p.label}` |
| 178 | `hint={p.description \|\| undefined}` |
| 185 | `<Field key={p.key} label={p.label} hint={p.description \|\| undefined} required={p.required}>` |
| 187 | `{!p.required && <option value="">—</option>}` |
| 189 | `<option key={o} value={o}>` |
| 223 | `<Button variant="secondary" loading={checking} onClick={() => void check()}>` |
| 224 | `Check prerequisites` |
| 282 | `loading={installing}` |
| 286 | `Create drafts` |
| 295 | `<Alert tone="good" title={′Created ${installed.artifacts.length} drafts′}>` |


### apps/web/src/features/templates/EditorPreview.tsx

[Baseline source](../../../apps/web/src/features/templates/EditorPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 21 | `readOnly,` |
| 27 | `readOnly?: boolean;` |
| 29 | `const [width, setWidth] = useState<'desktop' \| 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));` |
| 30 | `const [darkMail, setDarkMail] = useState(false);` |
| 31 | `const [tab, setTab] = useState<'html' \| 'text'>('html');` |
| 32 | `const draft = useDraftEmail(content, dirty && !readOnly);` |
| 38 | `() => api.call('templates.preview', { artifactId, version }),` |
| 39 | `{ skip: dirty },` |
| 41 | `const blocked = dirty && !readOnly && draft.state.status === 'blocked';` |
| 46 | `{ skip: !blocked },` |
| 50 | `dirty && !readOnly ? (draft.state.status === 'ready' ? draft.state.result : undefined) : saved.data;` |
| 51 | `const failure = dirty && !readOnly ? (draft.state.status === 'error' ? draft.state.message : null) : saved.error;` |
| 52 | `const rendering = dirty && !readOnly ? draft.state.status === 'rendering' \|\| draft.state.status === 'idle' : saved.loading;` |
| 61 | `label="Preview width"` |
| 65 | `{ key: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },` |
| 66 | `{ key: 'mobile', label: 'Mobile', icon: <Smartphone size={13} aria-hidden /> },` |
| 85 | `label="Preview content"` |
| 89 | `{ key: 'html', label: 'HTML', icon: <Eye size={13} aria-hidden /> },` |
| 90 | `{ key: 'text', label: 'Text version', icon: <FileText size={13} aria-hidden /> },` |
| 98 | `<Alert tone="warn" title="Save draft to render reusable blocks">` |
| 104 | `<summary className="cursor-pointer text-[12px] font-medium text-fg-2">Saved v{version} · previous saved preview</summary>` |
| 107 | `title="Previous saved e-mail preview"` |
| 118 | `<LoadingBlock lines={6} label={dirty ? 'Rendering draft…' : 'Rendering the e-mail'} />` |
| 122 | `title={dirty ? "Couldn't render this draft" : "Couldn't render this e-mail"}` |
| 144 | `None` |
| 152 | `<Alert tone="warn" title="Rendering warnings">` |
| 163 | `title={′E-mail preview, ${width}${darkMail ? ', dark mail' : ''}′}` |
| 170 | `) : dirty && !content.text?.trim() ? (` |
| 171 | `<Alert tone="info" title="Save draft to generate the text version">` |
| 172 | `The local renderer does not invent a text part from HTML. Add one under Advanced, or save and preview the server’s text` |
| 176 | `<CodeView value={shown.text \|\| '(empty)'} label="Plain-text part" maxHeight={620} />` |


### apps/web/src/features/templates/InsertPalette.tsx

[Baseline source](../../../apps/web/src/features/templates/InsertPalette.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useRef, useState } from 'react';` |
| 9 | `const ELEMENTS: { kind: InsertElementKind; label: string; icon: React.ReactNode }[] = [` |
| 10 | `{ kind: 'text', label: 'Text', icon: <Type size={16} aria-hidden /> },` |
| 11 | `{ kind: 'image', label: 'Image', icon: <ImageIcon size={16} aria-hidden /> },` |
| 12 | `{ kind: 'button', label: 'Button', icon: <ChevronRight size={16} aria-hidden /> },` |
| 13 | `{ kind: 'divider', label: 'Divider', icon: <Minus size={16} aria-hidden /> },` |
| 14 | `{ kind: 'spacer', label: 'Spacer', icon: <MoveVertical size={16} aria-hidden /> },` |
| 15 | `{ kind: 'columns', label: 'Columns', icon: <Square size={16} aria-hidden /> },` |
| 35 | `const [tab, setTab] = useState<'elements' \| 'blocks'>('elements');` |
| 36 | `const [query, setQuery] = useState('');` |
| 37 | `const [columns, setColumns] = useState(false);` |
| 64 | `aria-label="Insert"` |
| 69 | `label="Insert category"` |
| 73 | `{ key: 'elements', label: 'Elements' },` |
| 74 | `{ key: 'blocks', label: 'Reusable blocks' },` |
| 78 | `<Field label="Find an element or block">` |


### apps/web/src/features/templates/TemplateEditor.tsx

[Baseline source](../../../apps/web/src/features/templates/TemplateEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';` |
| 35 | `export function TemplateEditor({ artifact, content, onChange, readOnly, errors }: EditorProps<TemplateContent>) {` |
| 36 | `const [view, setView] = useState<'visual' \| 'code' \| 'preview'>('visual');` |
| 37 | `const [inserting, setInserting] = useState(false);` |
| 38 | `const [picking, setPicking] = useState(false);` |
| 39 | `const [pendingInsert, setPendingInsert] = useState<{ kind: InsertElementKind; columns?: 1 \| 2 } \| null>(null);` |
| 40 | `const [visualReady, setVisualReady] = useState(false);` |
| 41 | `const [outlines, setOutlines] = useState(false);` |
| 42 | `const purposes = useApi(() => api.call('purposes.list', {}), []);` |
| 49 | `const lost = useMemo(() => lostLiquid(saved, content.mjml), [saved, content.mjml]);` |
| 55 | `const clean = content.mjml === saved;` |
| 76 | `set({ mjml: ′${content.mjml}\n${tag}′ });` |
| 79 | `const at = el.selectionStart ?? content.mjml.length;` |
| 80 | `set({ mjml: content.mjml.slice(0, at) + tag + content.mjml.slice(at) });` |
| 109 | `<Field label="Subject" hint="Liquid works here, e.g. {{ profile.firstName \| default: 'there' }}." error={errors.subject} required>` |
| 110 | `<Input value={content.subject ?? ''} readOnly={readOnly} maxLength={300} onChange={(e) => set({ subject: e.target.value })} />` |
| 112 | `<Field label="Preheader" hint="The preview text inboxes show after the subject." error={errors.preheader}>` |
| 114 | `value={content.preheader ?? ''}` |
| 115 | `readOnly={readOnly}` |
| 120 | `<Field label="Purpose" hint="Decides consent and the unsubscribe link." error={errors.purpose} required>` |
| 122 | `value={content.purpose ?? ''}` |
| 123 | `disabled={readOnly \|\| purposes.loading}` |
| 127 | `set({ purpose, topic: content.topic && keys.includes(content.topic) ? content.topic : undefined });` |
| 130 | `{!purposes.data?.purposes.some((p) => p.key === content.purpose) && (` |
| 131 | `<option value={content.purpose}>{content.purpose \|\| 'Choose…'}</option>` |
| 134 | `<option key={p.key} value={p.key}>` |
| 140 | `<Field label="Topic (optional)" hint="A finer choice under the purpose." error={errors.topic}>` |
| 142 | `value={content.topic ?? ''}` |
| 143 | `disabled={readOnly \|\| purposes.loading \|\| topicsOf(purposes.data?.purposes ?? [], content.purpose).length === 0}` |
| 146 | `<option value="">{topicsOf(purposes.data?.purposes ?? [], content.purpose).length ? 'No topic' : 'No topics'}</option>` |
| 147 | `{topicsOf(purposes.data?.purposes ?? [], content.purpose).map((t) => (` |
| 148 | `<option key={t.key} value={t.key}>` |
| 158 | `label="Editor"` |
| 162 | `{ key: 'visual', label: 'Visual', icon: <Paintbrush size={13} aria-hidden /> },` |
| 163 | `{ key: 'code', label: 'MJML and Liquid', icon: <Code2 size={13} aria-hidden /> },` |
| 166 | `{!readOnly && (` |
| 177 | `Insert` |
| 200 | `label="Undo"` |
| 207 | `label="Redo"` |
| 224 | `Outlines` |
| 235 | `Preview` |
| 239 | `<Alert tone="warn" title="Liquid changed in the visual editor">` |
| 246 | `<EditorPreview artifactId={artifact.id} version={artifact.version.number} content={content} dirty={dirty} readOnly={readOnly} />` |
| 248 | `readOnly ? (` |
| 252 | `<Suspense fallback={<LoadingBlock lines={8} label="Loading the visual editor" />}>` |
| 256 | `mjml={content.mjml}` |
| 264 | `<Field label="MJML with Liquid" hideLabel>` |
| 271 | `value={content.mjml}` |
| 278 | `<summary className="cursor-pointer text-[13px] font-medium">Advanced: text version, sample data, UTM</summary>` |
| 280 | `<Field label="Plain-text version" hint="Leave empty to generate it from the HTML." error={errors.text}>` |
| 284 | `value={content.text ?? ''}` |
| 290 | `label="Sample data for previews"` |
| 291 | `hint='Variables used by Preview and tests, e.g. {"profile": {"firstName": "Ada"}}.'` |
| 292 | `value={content.sampleData ?? {}}` |
| 298 | `<Field label="UTM source" hint="Default newsletter." error={errors['utm.source']}>` |
| 300 | `value={content.utm?.source ?? ''}` |
| 302 | `onChange={(e) => set({ utm: { ...(content.utm ?? {}), source: e.target.value \|\| undefined } })}` |
| 305 | `<Field label="UTM medium" hint="Default email." error={errors['utm.medium']}>` |
| 307 | `value={content.utm?.medium ?? ''}` |
| 309 | `onChange={(e) => set({ utm: { ...(content.utm ?? {}), medium: e.target.value \|\| undefined } })}` |
| 312 | `<Field label="UTM campaign" hint="e.g. signal-43." error={errors['utm.campaign']}>` |
| 314 | `value={content.utm?.campaign ?? ''}` |
| 316 | `onChange={(e) => set({ utm: { ...(content.utm ?? {}), campaign: e.target.value \|\| undefined } })}` |
| 324 | `title="Insert an image"` |


### apps/web/src/features/blocks/BlockEditor.tsx

[Baseline source](../../../apps/web/src/features/blocks/BlockEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 10 | `export function BlockEditor({ content, onChange, readOnly, errors }: EditorProps<BlockContent>) {` |
| 13 | `set({ params: content.params.map((param, index) => (index === i ? { ...param, ...p } : param)) });` |
| 17 | `<Field label="Description" hint="What the block is for, shown to reviewers and agents." error={errors.description}>` |
| 19 | `value={content.description ?? ''}` |
| 20 | `readOnly={readOnly}` |
| 25 | `<Field label="Category" hint="Groups the block in the template editor." error={errors.category} required>` |
| 26 | `<Select value={content.category} disabled={readOnly} onChange={(e) => set({ category: e.target.value as BlockCategory })}>` |
| 28 | `<option key={value} value={value}>` |
| 37 | `label="MJML fragment"` |
| 38 | `hint="Sections or columns, not a whole <mjml> document. Use {{ block.<key> }} for parameters; profile.* and unsubscribe_url also work."` |
| 46 | `value={content.mjml}` |
| 51 | `<section aria-label="Parameters" className="rounded-lg border border-line bg-surface px-4 py-3">` |
| 57 | `{!readOnly && (` |
| 63 | `params: [...content.params, { key: '', label: '', type: 'text', required: false }],` |
| 67 | `Add parameter` |
| 71 | `{content.params.length === 0 ? (` |
| 75 | `{content.params.map((param, i) => (` |
| 83 | `<Field label="Key" hint="block.<key>" error={errors[′params.${i}.key′]}>` |
| 89 | `onChange={(e) => setParam(i, { key: e.target.value })}` |
| 92 | `<Field label="Label" error={errors[′params.${i}.label′]}>` |
| 93 | `<Input value={param.label} readOnly={readOnly} maxLength={120} onChange={(e) => setParam(i, { label: e.target.value })} />` |
| 95 | `<Field label="Type" error={errors[′params.${i}.type′]}>` |
| 96 | `<Select value={param.type} disabled={readOnly} onChange={(e) => setParam(i, { type: e.target.value as BlockParamType })}>` |
| 98 | `<option key={t.value} value={t.value}>` |
| 104 | `<Field label="Max length" error={errors[′params.${i}.maxLength′]}>` |
| 114 | `<Field label="Default" hint="Used when the template omits it." error={errors[′params.${i}.default′]}>` |
| 124 | `label="Required"` |
| 126 | `disabled={readOnly}` |
| 134 | `aria-label={′Remove ${param.key \|\| 'parameter'}′}` |
| 135 | `onClick={() => set({ params: content.params.filter((_, index) => index !== i) })}` |


### apps/web/src/features/blocks/BlockPicker.tsx

[Baseline source](../../../apps/web/src/features/blocks/BlockPicker.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useState } from 'react';` |
| 22 | `const [busy, setBusy] = useState<string \| null>(null);` |
| 23 | `const [error, setError] = useState<string \| null>(null);` |
| 30 | `const a = await api.call('artifacts.get', { artifactId: id });` |
| 39 | `if (list.loading) return <LoadingBlock lines={4} label="Loading blocks" />;` |
| 40 | `if (list.error)` |
| 43 | `{list.error}` |
| 94 | `<Modal open onClose={onClose} title="Insert a block" footer={<Button onClick={onClose}>Cancel</Button>}>` |
| 96 | `The tag goes into the MJML and expands to the block’s published version when the e-mail is rendered. Fill the placeholders before` |


### apps/web/src/features/blocks/BlockUsage.tsx

[Baseline source](../../../apps/web/src/features/blocks/BlockUsage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 8 | `const usage = useApi(() => api.call('blocks.usage', { artifactId }), [artifactId]);` |
| 9 | `if (usage.loading) return <LoadingBlock lines={2} label="Looking up where the block is used" />;` |
| 10 | `if (usage.error)` |
| 13 | `{usage.error}` |
| 18 | `<section aria-label="Used by" className="rounded-lg border border-line bg-surface-2 px-4 py-3">` |


### apps/web/src/features/brand/BrandEditor.tsx

[Baseline source](../../../apps/web/src/features/brand/BrandEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 6 | `import { COLOR_LABEL, COPY_GROUPS, type ColorKey, contrast, DEFAULT_COLORS, DEFAULT_COPY, DEFAULT_FONT, FONT_PRESETS } from './defaults';` |
| 19 | `copy?: Partial<Record<keyof typeof DEFAULT_COPY, string>>;` |
| 39 | `readOnly,` |
| 46 | `readOnly: boolean;` |
| 51 | `const [picking, setPicking] = useState(false);` |
| 53 | `const colors = { ...DEFAULT_COLORS, ...(value.colors ?? {}) };` |
| 57 | `{ label: 'Text on page background', ratio: contrast(colors.text, colors.background) },` |
| 58 | `{ label: 'Text on card', ratio: contrast(colors.text, colors.surface) },` |
| 59 | `{ label: 'Button text on the accent colour', ratio: contrast(colors.accentText, colors.accent) },` |
| 60 | `{ label: 'Secondary text on card', ratio: contrast(colors.muted, colors.surface) },` |
| 66 | `<FieldGroup legend="Site">` |
| 68 | `<Field label="Site name" hint="Shown at the top when there is no logo, and in “Back to …”." error={err('siteName')}>` |
| 69 | `<Input value={value.siteName ?? ''} readOnly={readOnly} maxLength={120} onChange={(e) => set({ siteName: e.target.value })} />` |
| 71 | `<Field label="Site address" hint="Where “Back to …” goes. https://…" error={err('siteUrl')}>` |
| 75 | `readOnly={readOnly}` |
| 82 | `label="Language"` |
| 83 | `hint="Page language for screen readers and browsers, e.g. en, da or pt-BR."` |
| 99 | `legend="Newsletter archive"` |
| 100 | `hint="A public archive of sent issues on your links address (/n/<slug>/), with RSS and a sitemap. Published issues use the template version that was sent, without any reader's personal data."` |
| 103 | `label="Publish a newsletter archive"` |
| 104 | `hint="Only sent broadcasts that are also marked “Publish to the archive” appear."` |
| 106 | `disabled={readOnly}` |
| 112 | `<Field label="Archive title" hint="Shown on the index and in the feed." error={err('archive.title')}>` |
| 118 | `onChange={(e) => set({ archive: { ...(value.archive ?? {}), title: e.target.value } })}` |
| 122 | `label="Archive address"` |
| 123 | `hint="Lowercase letters, digits and hyphens; unique on this install."` |
| 136 | `<Field label="Description" hint="A sentence for the index and the feed." error={err('archive.description')}>` |
| 146 | `label="Subscribe link"` |
| 147 | `hint="Optional. Shown as the archive's subscribe button, e.g. your signup form."` |
| 163 | `<FieldGroup legend="Logo">` |
| 172 | `{!readOnly && (` |
| 179 | `Remove` |
| 187 | `<Field label="Logo alt text" hint="Defaults to the site name." error={err('logoAlt')}>` |
| 188 | `<Input value={value.logoAlt ?? ''} readOnly={readOnly} maxLength={200} onChange={(e) => set({ logoAlt: e.target.value })} />` |
| 190 | `<Field label="Logo height" unit="px" hint="16 to 96." error={err('logoHeight')}>` |
| 206 | `legend="Colours"` |
| 207 | `hint={override ? 'Empty colours use the workspace brand.' : 'Checked against WCAG AA (4.5:1) as you change them.'}` |
| 210 | `{(Object.keys(DEFAULT_COLORS) as ColorKey[]).map((k) => (` |
| 211 | `<Field key={k} label={COLOR_LABEL[k]} error={err(′colors.${k}′)}>` |
| 215 | `aria-label={′${COLOR_LABEL[k]} colour picker′}` |
| 223 | `placeholder={override ? 'Workspace brand' : DEFAULT_COLORS[k]}` |
| 234 | `<Alert tone="warn" title="Low contrast">` |
| 246 | `<FieldGroup legend="Type and shape">` |
| 248 | `<Field label="Font" hint="System fonts load instantly and need no third party." error={err('fontStack')}>` |
| 264 | `<option key={f.value} value={f.value}>` |
| 268 | `<option value="__custom">Custom font stack…</option>` |
| 271 | `<Field label="Corner radius" unit="px" hint="0 to 24." error={err('radius')}>` |
| 286 | `label="Custom font stack"` |
| 287 | `hint={'CSS font-family, e.g. "Inter", system-ui, sans-serif. The font must be installed on the reader’s device.'}` |
| 302 | `<summary className="cursor-pointer text-[13px] font-medium text-fg-2 hover:text-fg">` |
| 306 | `{COPY_GROUPS.map((g) => (` |
| 307 | `<FieldGroup key={g.page} legend={g.page}>` |
| 311 | `label={k` |
| 315 | `hint={′Default: “${DEFAULT_COPY[k]}”${k === 'backToSite' ? ' ({site} becomes the site name)' : ''}′}` |
| 321 | `placeholder={DEFAULT_COPY[k]}` |
| 334 | `title="Choose a logo"` |
| 347 | `export function BrandEditor({ content, onChange, readOnly, errors }: EditorProps<BrandContent>) {` |
| 350 | `<BrandFields value={content} onChange={onChange} readOnly={readOnly} errors={errors} />` |


### apps/web/src/features/brand/HostedPreview.tsx

[Baseline source](../../../apps/web/src/features/brand/HostedPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useState } from 'react';` |
| 28 | `const [page, setPage] = useState<PageKind>(initialPage);` |
| 29 | `const [width, setWidth] = useState<'desktop' \| 'mobile'>('desktop');` |
| 30 | `const [html, setHtml] = useState<string \| null>(null);` |
| 31 | `const [error, setError] = useState<string \| null>(null);` |
| 44 | `.call('hostedPages.preview', { page, ...(brand ? { brand: brand as never } : {}), ...(formId ? { formId } : {}) })` |
| 74 | `<Tabs label="Page" items={PAGE_KINDS.map((p) => ({ key: p.key, label: p.label }))} value={page} onChange={setPage} />` |
| 76 | `label="Preview width"` |
| 80 | `{ key: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },` |
| 81 | `{ key: 'mobile', label: 'Mobile', icon: <Smartphone size={13} aria-hidden /> },` |
| 86 | `<Alert tone="bad" title="Can't preview this yet">` |
| 93 | `title={′Hosted ${page} page preview′}` |


### apps/web/src/features/brand/NewBrandDrawer.tsx

[Baseline source](../../../apps/web/src/features/brand/NewBrandDrawer.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useState } from 'react';` |
| 13 | `const [name, setName] = useState('');` |
| 14 | `const [siteName, setSiteName] = useState('');` |
| 15 | `const [domain, setDomain] = useState('');` |
| 16 | `const [prefix, setPrefix] = useState('');` |
| 17 | `const [logoUrl, setLogoUrl] = useState('');` |
| 18 | `const [err, setErr] = useState('');` |
| 19 | `const [busy, setBusy] = useState(false);` |
| 39 | `title="New brand"` |
| 44 | `Cancel` |
| 46 | `<Button type="submit" form="new-brand" variant="primary" loading={busy}>` |
| 47 | `Create brand` |
| 60 | `const created = await api.call('workspace.create', {` |
| 78 | `<Field label="Brand name" required hint="Shown in the switcher and on hosted pages.">` |
| 81 | `<Field label="Primary domain" hint="Optional, e.g. links.example.com. It starts pending; verify it before it serves links.">` |
| 84 | `<Field label="Path prefix" hint="Optional, for a site that proxies /am to this installation.">` |
| 87 | `<Field label="Site name" hint="Optional; the hosted-page name. Defaults to the brand name.">` |
| 90 | `<Field label="Logo URL" hint="Optional https URL. You can change it later under Design → Brand.">` |


## S · #527


### apps/web/src/pages/settings/ApprovalPolicyPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/ApprovalPolicyPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useEffect, useState } from 'react';` |
| 13 | `const POLICY_INFO: Record<Policy, { label: string; description: string; agent: string; aftermath: string }> = {` |
| 15 | `label: 'No review',` |
| 21 | `label: 'Review agent changes',` |
| 27 | `label: 'Four-eyes',` |
| 38 | `useCrumbs([{ label: 'Approval policy' }]);` |
| 42 | `const [selected, setSelected] = useState<Policy>(workspace.approvalPolicy);` |
| 43 | `const [busy, setBusy] = useState(false);` |
| 44 | `const [error, setError] = useState<string \| null>(null);` |
| 45 | `const canAdmin = can('workspace:admin');` |
| 55 | `title: ′Relax the approval policy to “${POLICY_INFO[selected].label}”?′,` |
| 65 | `await api.call('workspace.setApprovalPolicy', { policy: selected });` |
| 80 | `title="Approval policy"` |
| 83 | `<Card title="Current policy" padded>` |
| 104 | `label: POLICY_INFO[value].label,` |
| 114 | `<Card title="Who has to approve a change" description="This applies to every artifact and broadcast in the workspace." padded>` |
| 117 | `Agents can never approve a change, whatever the policy. Approval is always a person’s decision.` |
| 120 | `<Alert tone="bad" title="Not saved" className="mt-4">` |
| 127 | `loading={busy}` |
| 129 | `title={selected === workspace.approvalPolicy ? 'Choose another policy first.' : undefined}` |
| 132 | `Save policy` |
| 144 | `const POLICY_TAB_ITEMS: { key: PolicyTab; label: string }[] = [` |
| 145 | `{ key: 'policy', label: 'Policy' },` |
| 146 | `{ key: 'autonomy', label: 'Agent autonomy' },` |
| 154 | `if (autonomy.loading && !autonomy.settings) return <LoadingBlock lines={4} label="Loading autonomy settings" />;` |
| 155 | `if (autonomy.error && !autonomy.settings)` |
| 157 | `<Alert tone="bad" title="Couldn't load autonomy settings" onRetry={() => void autonomy.reload()}>` |
| 158 | `{autonomy.error}` |
| 165 | `title="Agent autonomy"` |
| 170 | `canEdit={can('workspace:admin')}` |
| 183 | `useCrumbs([{ label: 'Approval policy and agent autonomy' }]);` |
| 189 | `This tab is unavailable.` |
| 192 | `<Tabs items={POLICY_TAB_ITEMS} value={active} onChange={select} label="Approval policy and agent autonomy">` |


### apps/web/src/pages/settings/IntegrationsPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/IntegrationsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 12 | `useCrumbs([{ label: 'Integrations and API tokens', to: '/settings/integrations' }, ...(params.id ? [{ label: 'Token' }] : [])]);` |
| 17 | `title="Integrations and API tokens"` |
| 22 | `{can('workspace:admin') && <SourcesCard />}` |
| 23 | `{can('artifacts:read') && <WebhooksCard />}` |
| 24 | `{can('artifacts:read') && <ConnectionsCard />}` |


### apps/web/src/pages/settings/PreferencesPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/PreferencesPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 8 | `const THEME_OPTIONS: { value: ThemePref; label: string; hint: string }[] = [` |
| 9 | `{ value: 'system', label: 'System', hint: 'Follows your device setting.' },` |
| 10 | `{ value: 'light', label: 'Light', hint: 'Always light.' },` |
| 11 | `{ value: 'dark', label: 'Dark', hint: 'Always dark.' },` |
| 16 | `useCrumbs([{ label: 'Preferences' }]);` |
| 23 | `<PageHeader title="Preferences" description="Your appearance on this device, and what your account and role allow." />` |
| 25 | `<Card title="Appearance" description="Kept for you on this device." padded>` |
| 28 | `<Card title="Account" description="You are signed in to this workspace." padded>` |
| 44 | `<Card title="What you can do" description="Your permissions in this workspace, and what each one allows." className="mt-5">` |


### apps/web/src/pages/settings/ProvidersPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/ProvidersPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 8 | `useCrumbs([{ label: 'Providers' }]);` |
| 12 | `title="Providers"` |


### apps/web/src/pages/settings/SecretsPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/SecretsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 8 | `Alert,` |
| 9 | `Button,` |
| 10 | `Checkbox,` |
| 11 | `Drawer,` |
| 12 | `EmptyState,` |
| 13 | `Field,` |
| 16 | `Input,` |
| 17 | `Mono,` |
| 18 | `PageHeader,` |
| 19 | `Table,` |
| 20 | `TableFrame,` |
| 21 | `Td,` |
| 22 | `THead,` |
| 23 | `Th,` |
| 24 | `Tr,` |
| 48 | `useCrumbs([{ label: 'Secrets' }]);` |
| 51 | `const list = useApi(() => api.call('secrets.list', {}), []);` |
| 53 | `const [editing, setEditing] = useState<Editing \| null>(null);` |
| 54 | `const [error, setError] = useState<string \| null>(null);` |
| 55 | `const canWrite = can('secrets:write');` |
| 60 | `title: ′Delete secret “${secret.name}”?′,` |
| 63 | `Anything that uses it, such as a provider, integration or agent setup, stops working until a new value is stored. The value cannot` |
| 73 | `await api.call('secrets.delete', { name: secret.name });` |
| 84 | `title="Secrets"` |
| 89 | `Add secret` |
| 97 | `title="That did not work"` |
| 101 | `Dismiss` |
| 109 | `loading={list.loading}` |
| 110 | `error={list.error}` |
| 116 | `title="No secrets stored"` |
| 131 | `<Table label="Secrets">` |
| 134 | `<Th>Name</Th>` |
| 135 | `<Th>Updated</Th>` |
| 136 | `<Th className="hidden md:table-cell">Last changed by</Th>` |
| 138 | `<Th>` |
| 151 | `<Td className="whitespace-nowrap" title={formatDateTime(s.updatedAt, { seconds: true, zone: true })}>` |
| 166 | `Rotate` |
| 169 | `Delete` |
| 197 | `const [name, setName] = useState(secret?.name ?? '');` |
| 198 | `const [value, setValue] = useState('');` |
| 199 | `const [show, setShow] = useState(false);` |
| 200 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 202 | `const [busy, setBusy] = useState(false);` |
| 219 | `await api.call('secrets.set', { name: storedName, value });` |
| 239 | `title={rotate ? ′Replace the value of “${secret!.name}”′ : 'Add secret'}` |
| 244 | `<Button variant="primary" loading={busy} onClick={() => void submit()}>` |
| 258 | `label="Name"` |
| 259 | `hint={` |
| 269 | `readOnly={rotate}` |
| 285 | `label={rotate ? 'New value' : 'Value'}` |
| 286 | `hint="Pasted values stay hidden. To change one later, store it again; it cannot be read back."` |
| 303 | `<Checkbox label="Show while typing" checked={show} onChange={(e) => setShow(e.target.checked)} />` |
| 305 | `<Alert tone="bad" title="Not saved">` |


### apps/web/src/pages/settings/SettingsPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/SettingsPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 13 | `return <LoadingBlock lines={3} label="Opening Settings" />;` |


### apps/web/src/pages/settings/UsersPage.tsx

[Baseline source](../../../apps/web/src/pages/settings/UsersPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 9 | `Alert,` |
| 10 | `Button,` |
| 11 | `Card,` |
| 12 | `Drawer,` |
| 13 | `EmptyState,` |
| 14 | `Field,` |
| 15 | `FieldGroup,` |
| 18 | `IconButton,` |
| 19 | `Input,` |
| 20 | `LoadingBlock,` |
| 21 | `PageHeader,` |
| 22 | `RadioCards,` |
| 23 | `Select,` |
| 24 | `StatusPill,` |
| 25 | `Table,` |
| 26 | `TableFrame,` |
| 27 | `Tag,` |
| 28 | `Td,` |
| 29 | `THead,` |
| 30 | `Th,` |
| 31 | `Tr,` |
| 45 | `useCrumbs([{ label: 'Users and roles' }]);` |
| 51 | `api.call('members.list', {}),` |
| 52 | `api.call('invitations.list', { status: 'pending' }),` |
| 53 | `api.call('sso.list', {}).catch(() => null),` |
| 54 | `api.call('scim.status', {}).catch(() => null),` |
| 58 | `const [inviting, setInviting] = useState(false);` |
| 59 | `const [busyId, setBusyId] = useState<string \| null>(null);` |
| 60 | `const [revoking, setRevoking] = useState<string \| null>(null);` |
| 61 | `const [error, setError] = useState<string \| null>(null);` |
| 83 | `title: ′Change ${personName(m)} from ${ROLE_LABEL[m.role]} to ${ROLE_LABEL[role]}?′,` |
| 97 | `await api.call('members.setRole', { userId: m.userId, role });` |
| 109 | `title: ′Remove ${personName(m)} from the workspace?′,` |
| 112 | `Their sessions and connected agents lose access immediately. Content they created stays in the workspace. You can invite them` |
| 123 | `await api.call('members.remove', { userId: m.userId });` |
| 135 | `title: ′Revoke the invitation for ${inv.email}?′,` |
| 144 | `await api.call('invitations.revoke', { id: inv.id });` |
| 157 | `title="Users and roles"` |
| 160 | `can('workspace:admin') && (` |
| 162 | `Invite person` |
| 168 | `<Alert tone="bad" title="That did not work" className="mb-4">` |
| 173 | `loading={data.loading}` |
| 174 | `error={data.error}` |
| 178 | `empty={<EmptyState title="No members">Invite a person to give them access to this workspace.</EmptyState>}` |
| 180 | `<Table label="Members">` |
| 183 | `<Th>Person</Th>` |
| 184 | `<Th>Role</Th>` |
| 185 | `<Th className="hidden md:table-cell">Member since</Th>` |
| 186 | `<Th>` |
| 202 | `<span title={roleBlockReason(m)} className="inline-block">` |
| 205 | `aria-label={′Role for ${personName(m)}′}` |
| 212 | `<option key={r} value={r} disabled={r === 'owner' && !isOwner}>` |
| 221 | `<span title={removeBlockReason(m)} className="inline-block">` |
| 225 | `label={′Remove ${personName(m)}′}` |
| 240 | `title="Pending invitations"` |
| 248 | `{data.loading ? (` |
| 249 | `<LoadingBlock lines={2} label="Loading invitations" />` |
| 268 | `<Button size="sm" variant="ghost" loading={revoking === inv.id} onClick={() => void revoke(inv)}>` |
| 269 | `Revoke` |
| 278 | `title="Single sign-on and provisioning"` |
| 337 | `const [email, setEmail] = useState('');` |
| 338 | `const [role, setRole] = useState<Role>('marketer');` |
| 339 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 341 | `const [busy, setBusy] = useState(false);` |
| 342 | `const [invited, setInvited] = useState<{ email: string; link: string; expiresAt: string } \| null>(null);` |
| 361 | `const r = await api.call('members.invite', { email: address, role });` |
| 379 | `toast.error('Could not copy the link. Select it and copy it yourself.');` |
| 385 | `label: ROLE_LABEL[r],` |
| 393 | `title="Invite person"` |
| 398 | `Done` |
| 403 | `<Button variant="primary" loading={busy} onClick={() => void submit()}>` |
| 404 | `Create invitation` |
| 412 | `<Alert tone="good" title="Invitation created">` |
| 416 | `<Field label="Invitation link" hint="Shown only now. Copy it before you close this drawer.">` |
| 418 | `<Input readOnly value={invited.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />` |
| 420 | `Copy` |
| 433 | `<Field label="E-mail address" hint="They accept the invitation while signed in with this address." error={errors.email} required>` |
| 450 | `<FieldGroup legend="Role" hint="What they can do after they accept. You can change it later.">` |
| 454 | `<Alert tone="bad" title="Not invited">` |


### apps/web/src/pages/settings/WorkspacePage.tsx

[Baseline source](../../../apps/web/src/pages/settings/WorkspacePage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useEffect, useMemo, useState } from 'react';` |
| 34 | `useCrumbs([{ label: 'Workspace' }]);` |
| 37 | `const [name, setName] = useState(workspace.name);` |
| 38 | `const [timeZone, setTimeZone] = useState(workspace.timeZone);` |
| 39 | `const [seedText, setSeedText] = useState(workspace.seedList.join('\n'));` |
| 40 | `const [nameError, setNameError] = useState<string \| null>(null);` |
| 41 | `const [seedError, setSeedError] = useState<string \| null>(null);` |
| 42 | `const [generalError, setGeneralError] = useState<string \| null>(null);` |
| 43 | `const [seedSaveError, setSeedSaveError] = useState<string \| null>(null);` |
| 44 | `const [savingGeneral, setSavingGeneral] = useState(false);` |
| 45 | `const [savingSeed, setSavingSeed] = useState(false);` |
| 76 | `await api.call('workspace.update', { name: name.trim(), timeZone });` |
| 95 | `await api.call('workspace.setSeedList', { seedList: parsed.emails });` |
| 111 | `<PageHeader title="Workspace" description="The name and time zone everyone sees, and the addresses that may receive test sends." />` |
| 113 | `<Card title="General" description="Shown throughout the admin UI and in messages where the workspace is named.">` |
| 121 | `<Field label="Name" error={nameError} required>` |
| 132 | `<Field label="Time zone" hint="Dates and the send-time picker use this zone.">` |
| 135 | `<option key={z} value={z}>` |
| 142 | `<Alert tone="bad" title="Not saved">` |
| 147 | `<Button type="submit" variant="primary" loading={savingGeneral}>` |
| 148 | `Save` |
| 154 | `<Card title="Test sends" description="Addresses outside the workspace that test sends may go to, such as a monitoring inbox.">` |
| 163 | `label="Seed list"` |
| 164 | `hint="One e-mail address per line, at most 50. Test sends go to these addresses as well as workspace members; real broadcasts are not affected."` |
| 189 | `<Button type="submit" variant="primary" loading={savingSeed}>` |
| 190 | `Save test sends` |


### apps/web/src/features/providers/EmailProviders.tsx

[Baseline source](../../../apps/web/src/features/providers/EmailProviders.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 6 | `Alert,` |
| 7 | `Button,` |
| 8 | `Card,` |
| 9 | `Checkbox,` |
| 10 | `CodeView,` |
| 11 | `Drawer,` |
| 12 | `EmptyState,` |
| 13 | `Field,` |
| 14 | `FieldGroup,` |
| 16 | `Input,` |
| 17 | `LoadingBlock,` |
| 18 | `Menu,` |
| 19 | `Modal,` |
| 20 | `Select,` |
| 21 | `StatusPill,` |
| 22 | `Switch,` |
| 23 | `Tag,` |
| 34 | `const USE_TEXT: Record<Use, { label: string; hint: string }> = {` |
| 35 | `transactional: { label: 'Transactional', hint: 'Confirmations, receipts and other messages people expect (contract or legal purposes).' },` |
| 36 | `marketing: { label: 'Marketing', hint: 'Newsletters, broadcasts and journeys that need consent.' },` |
| 50 | `const list = useApi(() => api.call('emailProviders.list', {}), []);` |
| 53 | `const [editing, setEditing] = useState<Provider \| 'new' \| null>(null);` |
| 54 | `const [webhook, setWebhook] = useState<{ name: string; url: string } \| null>(null);` |
| 55 | `const [busy, setBusy] = useState<string \| null>(null);` |
| 62 | `await api.call('emailProviders.update', { id: p.id, enabled: !p.enabled });` |
| 68 | `toast.error(′Couldn't change “${p.name}”: ${errText(e)}′);` |
| 75 | `title: ′Replace the webhook URL of “${p.name}”?′,` |
| 82 | `const r = await api.call('emailProviders.rotateWebhook', { id: p.id });` |
| 85 | `toast.error(errText(e));` |
| 90 | `title: ′Delete “${p.name}”?′,` |
| 104 | `await api.call('emailProviders.delete', { id: p.id });` |
| 114 | `title="E-mail"` |
| 118 | `Add provider` |
| 122 | `{list.loading ? (` |
| 124 | `) : list.error ? (` |
| 126 | `<Alert tone="bad" title="Couldn't load e-mail providers" onRetry={list.reload}>` |
| 127 | `{list.error}` |
| 134 | `<Alert tone="warn" title="Provider tracking overrides your setting">` |
| 141 | `title="No e-mail provider yet"` |
| 148 | `Add one to send e-mail: Postmark, Amazon SES, Brevo, Cloudflare or any SMTP relay. Until then, nothing is sent.` |
| 182 | `label={p.enabled ? 'Enabled' : 'Disabled'}` |
| 186 | `Edit` |
| 189 | `label={′More for ${p.name}′}` |
| 191 | `{ label: 'Replace webhook URL', icon: <RefreshCw />, onSelect: () => void rotate(p) },` |
| 193 | `{ label: 'Delete', icon: <Trash2 />, destructive: true, onSelect: () => void remove(p) },` |
| 199 | `aria-label={′More actions for ${p.name}′}` |
| 231 | `title={′Webhook URL for “${webhook.name}”′}` |
| 264 | `const [adapterId, setAdapterId] = useState<string>(provider?.adapter ?? adapters.find((a) => a.id === 'postmark')?.id ?? adapters[0]!.id);` |
| 266 | `const [name, setName] = useState(provider?.name ?? '');` |
| 267 | `const [fromEmail, setFromEmail] = useState(provider?.fromEmail ?? '');` |
| 268 | `const [fromName, setFromName] = useState(provider?.fromName ?? '');` |
| 269 | `const [replyTo, setReplyTo] = useState(provider?.replyTo ?? '');` |
| 270 | `const [useFor, setUseFor] = useState<Use[]>(provider?.useFor ?? (others.length ? [] : ['transactional', 'marketing']));` |
| 271 | `const [config, setConfig] = useState<Record<string, unknown>>(` |
| 274 | `const [secrets, setSecrets] = useState<Record<string, unknown>>({});` |
| 275 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 276 | `const [error, setError] = useState<string \| null>(null);` |
| 277 | `const [busy, setBusy] = useState(false);` |
| 278 | `const [blurred, setBlurred] = useState<Record<string, boolean>>({});` |
| 298 | `await api.call('emailProviders.update', {` |
| 311 | `const r = await api.call('emailProviders.create', {` |
| 340 | `title={provider ? ′Edit “${provider.name}”′ : 'Add an e-mail provider'}` |
| 345 | `Cancel` |
| 347 | `<Button variant="primary" className="ml-auto" loading={busy} onClick={save}>` |
| 361 | `<Field label="Provider" hint="Which service delivers the e-mail." required>` |
| 374 | `<option key={a.id} value={a.id}>` |
| 383 | `title={adapter.tracking === 'forced' ? ′${adapter.label} tracks every message′ : 'Tracking by the provider'}` |
| 400 | `<Field label="Name" hint="For your team, e.g. “Postmark (newsletter)”." error={err('name')} required>` |
| 409 | `<FieldGroup legend="Sender">` |
| 411 | `<Field label="From address" error={err('fromEmail')} hint="Must be on a domain verified with the provider." required>` |
| 420 | `<Field label="From name" error={err('fromName')} hint="Shown in the inbox, e.g. your newsletter's name.">` |
| 424 | `<Field label="Reply-to address" error={err('replyTo')} hint="Optional. Where replies go if not to the from address.">` |
| 435 | `<FieldGroup legend="Use for" hint="Each use goes through one provider; choosing one here takes it from the other provider.">` |
| 441 | `label={USE_TEXT[u].label}` |
| 442 | `hint={′${USE_TEXT[u].hint}${other && useFor.includes(u) ? ′ Moves it from “${other.name}”.′ : other ? ′ Now sent by “${other.name}”.′ : ''}′}` |
| 451 | `<FieldGroup legend="Settings">` |
| 456 | `legend={` |
| 475 | `<Alert tone="bad" title={provider ? 'Not saved' : 'Not added'}>` |


### apps/web/src/features/providers/OtherProviders.tsx

[Baseline source](../../../apps/web/src/features/providers/OtherProviders.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 6 | `Alert,` |
| 7 | `Button,` |
| 8 | `Card,` |
| 9 | `Checkbox,` |
| 10 | `CodeView,` |
| 11 | `Drawer,` |
| 12 | `EmptyState,` |
| 13 | `Field,` |
| 14 | `FieldGroup,` |
| 16 | `Input,` |
| 17 | `LoadingBlock,` |
| 18 | `Menu,` |
| 19 | `Modal,` |
| 20 | `Select,` |
| 21 | `StatusPill,` |
| 22 | `Switch,` |
| 23 | `Table,` |
| 24 | `TableFrame,` |
| 25 | `Tag,` |
| 26 | `Td,` |
| 27 | `THead,` |
| 28 | `Th,` |
| 29 | `Tr,` |
| 43 | `const SMS_ADAPTERS: { id: SmsAdapter; label: string }[] = [` |
| 44 | `{ id: 'twilio', label: 'Twilio' },` |
| 45 | `{ id: 'log', label: 'Development outbox (sends nothing)' },` |
| 47 | `const PUSH_ADAPTERS: { id: PushAdapter; label: string }[] = [` |
| 48 | `{ id: 'webpush', label: 'Web push (browsers)' },` |
| 49 | `{ id: 'fcm', label: 'Firebase Cloud Messaging (Android)' },` |
| 50 | `{ id: 'apns', label: 'Apple Push Notification service (Apple apps)' },` |
| 58 | `const MESSAGE_USES: { id: MessageUse; label: string }[] = [` |
| 59 | `{ id: 'transactional', label: 'Transactional messages' },` |
| 60 | `{ id: 'marketing', label: 'Marketing messages' },` |
| 62 | `const AI_USES: { id: AiUse; label: string }[] = [` |
| 63 | `{ id: 'journeys', label: 'Journeys' },` |
| 64 | `{ id: 'copilot', label: 'Copilot' },` |
| 65 | `{ id: 'decisions', label: 'Decision models (scores)' },` |
| 106 | `options: { id: T; label: string }[];` |
| 111 | `<FieldGroup legend="Use for" hint="Leave both empty to keep the provider available but unused.">` |
| 113 | `<Checkbox key={o.id} label={o.label} checked={value.includes(o.id)} onChange={() => toggle(o.id)} />` |
| 123 | `label={′More for ${name}′}` |
| 128 | `aria-label={′More for ${name}′}` |
| 134 | `items={[{ label: 'Delete', icon: <Trash2 size={14} />, destructive: true, disabled: busy, onSelect: onDelete }]}` |
| 166 | `accountSid: String(p?.config.accountSid ?? ''),` |
| 167 | `messagingServiceSid: String(p?.config.messagingServiceSid ?? ''),` |
| 168 | `apiBase: String(p?.config.apiBase ?? 'https://api.twilio.com'),` |
| 183 | `e['config.accountSid'] = 'Enter the Twilio account SID (starts with AC, then 32 hex characters).';` |
| 185 | `e['config.messagingServiceSid'] = 'Enter a messaging service SID (starts with MG, then 32 hex characters), or leave it empty.';` |
| 186 | `if (!/^https?:\/\//.test(f.apiBase.trim())) e['config.apiBase'] = 'Enter the API base URL, for example https://api.twilio.com.';` |
| 209 | `const [f, setF] = useState<SmsForm>(() => smsFormOf(provider));` |
| 210 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 211 | `const [error, setError] = useState<string \| null>(null);` |
| 212 | `const [saving, setSaving] = useState(false);` |
| 214 | `const set = <K extends keyof SmsForm>(key: K, value: SmsForm[K]) => setF((cur) => ({ ...cur, [key]: value }));` |
| 240 | `await api.call('smsProviders.update', {` |
| 251 | `const created = await api.call('smsProviders.create', {` |
| 278 | `title={provider ? ′Edit ${provider.name}′ : 'Add SMS provider'}` |
| 283 | `Cancel` |
| 285 | `<Button variant="primary" type="submit" form="sms-provider-form" loading={saving}>` |
| 299 | `<Field label="Name" hint="How this provider appears in journeys and settings." error={errors.name} required>` |
| 303 | `label="Adapter"` |
| 304 | `hint={` |
| 319 | `<option key={a.id} value={a.id}>` |
| 326 | `label="Sender"` |
| 327 | `hint="The number recipients see. Use E.164 format such as +14155550123, or an alphanumeric sender ID."` |
| 335 | `<FieldGroup legend="Cost and limits">` |
| 337 | `<Field label="Cost per segment" unit={f.currency \|\| 'USD'} error={errors.price} hint="Used to estimate journey costs." required>` |
| 341 | `label="Monthly budget"` |
| 344 | `hint="Optional. Sending stops when the budget is reached."` |
| 350 | `<Field label="Currency" hint="Three-letter code, for example USD." error={errors.currency}>` |
| 353 | `<Field label="Help text" hint="Appended where opt-out instructions are required." error={errors.helpText}>` |
| 361 | `<FieldGroup legend="Twilio settings">` |
| 362 | `<Field label="Account SID" error={errors['config.accountSid']} hint="Starts with AC, followed by 32 characters." required>` |
| 366 | `label="Messaging service SID"` |
| 367 | `error={errors['config.messagingServiceSid']}` |
| 368 | `hint="Optional. Use it to let Twilio choose a sender from a pool."` |
| 373 | `label="API base URL"` |
| 374 | `error={errors['config.apiBase']}` |
| 375 | `hint="Leave the default unless you use a Twilio-compatible gateway."` |
| 381 | `label="Auth token"` |
| 394 | `<Alert tone="info" title="Development outbox">` |
| 395 | `Messages are written to the server log and are not delivered. Use it to test journeys without a Twilio account.` |
| 400 | `<Alert tone="bad" title={provider ? 'Not saved' : 'Not added'}>` |
| 410 | `const list = useApi(() => api.call('smsProviders.list', {}), []);` |
| 413 | `const [editing, setEditing] = useState<Sms \| 'new' \| null>(null);` |
| 414 | `const [created, setCreated] = useState<{ name: string; url: string } \| null>(null);` |
| 415 | `const [busy, setBusy] = useState<string \| null>(null);` |
| 420 | `await api.call('smsProviders.update', { id: p.id, enabled: !p.enabled });` |
| 428 | `toast.error(errText(e));` |
| 436 | `title: ′Delete “${p.name}”?′,` |
| 445 | `await api.call('smsProviders.delete', { id: p.id });` |
| 459 | `title="SMS"` |
| 463 | `Add SMS provider` |
| 467 | `{list.loading ? (` |
| 469 | `) : list.error ? (` |
| 471 | `<Alert tone="bad" title="Couldn't load SMS providers" onRetry={list.reload}>` |
| 472 | `{errText(list.error)}` |
| 478 | `title="No SMS provider yet"` |
| 485 | `Add Twilio so journeys and broadcasts can send text messages, or a development outbox that only writes to the server log. Set` |
| 490 | `<Table label="SMS providers">` |
| 493 | `<Th>Name</Th>` |
| 494 | `<Th className="hidden md:table-cell">Sender</Th>` |
| 495 | `<Th className="hidden lg:table-cell">Use for</Th>` |
| 496 | `<Th className="hidden md:table-cell">Cost</Th>` |
| 497 | `<Th>Status</Th>` |
| 498 | `<Th align="right">Actions</Th>` |
| 512 | `<span className="min-w-0 truncate font-mono" title={url}>` |
| 516 | `<CopyInline value={url} label="Copy incoming messages URL" />` |
| 539 | `label={′Enable ${p.name}′}` |
| 544 | `Edit` |
| 581 | `title={′Incoming messages URL for “${created?.name ?? ''}”′}` |
| 589 | `<CodeView value={created?.url ?? ''} label="Webhook URL" maxHeight={120} />` |
| 598 | `function CopyInline({ value, label }: { value: string; label: string }) {` |
| 599 | `const [copied, setCopied] = useState(false);` |
| 603 | `aria-label={copied ? 'Copied' : label}` |
| 604 | `title={copied ? 'Copied' : label}` |
| 664 | `e['config.subject'] = 'Enter a contact for the VAPID token, starting with mailto: or https://.';` |
| 667 | `e['config.projectId'] = 'Enter the Firebase project ID (4–40 lowercase letters, digits or dashes).';` |
| 668 | `if (!/^https?:\/\//.test(f.apiBase.trim())) e['config.apiBase'] = 'Enter the FCM API base URL.';` |
| 669 | `if (!/^https?:\/\//.test(f.tokenUrl.trim())) e['config.tokenUrl'] = 'Enter the OAuth token URL.';` |
| 677 | `if (!/^[A-Z0-9]{10}$/.test(f.teamId.trim())) e['config.teamId'] = 'Enter the 10-character Apple team ID.';` |
| 678 | `if (!/^[A-Z0-9]{10}$/.test(f.keyId.trim())) e['config.keyId'] = 'Enter the 10-character key ID.';` |
| 679 | `if (f.topic.trim().length < 3) e['config.topic'] = 'Enter the app bundle ID.';` |
| 681 | `e['config.apiBase'] = 'Enter an Apple Push Notification service URL, or leave it empty.';` |
| 688 | `const [f, setF] = useState<PushForm>(() => pushFormOf(provider));` |
| 693 | `const set = <K extends keyof PushForm>(key: K, value: PushForm[K]) => setF((cur) => ({ ...cur, [key]: value }));` |
| 728 | `await api.call('pushProviders.update', { id: provider.id, ...base, enabled: f.enabled });` |
| 732 | `const created = await api.call('pushProviders.create', { ...base, adapter: f.adapter });` |
| 751 | `title={provider ? ′Edit ${provider.name}′ : 'Add push provider'}` |
| 758 | `<Button variant="primary" type="submit" form="push-provider-form" loading={saving}>` |
| 799 | `label="Enabled"` |
| 800 | `hint="Disabled providers are skipped; push steps then do nothing."` |
| 809 | `label="Contact"` |
| 810 | `error={errors['config.subject']}` |
| 811 | `hint="A mailto: or https:// address for the VAPID token. Push services use it to contact you about your traffic."` |
| 816 | `<Alert tone="info" title={editing ? 'VAPID keys stay as they are' : 'VAPID keys are generated for you'}>` |
| 821 | `{editing && provider && typeof provider.config.publicKey === 'string' && (` |
| 822 | `<Field label="Public key" hint="Give this to your browser app when it subscribes to push.">` |
| 823 | `<Input readOnly value={provider.config.publicKey} className="font-mono" onFocus={(e) => e.currentTarget.select()} />` |
| 831 | `<FieldGroup legend="Firebase settings">` |
| 832 | `<Field label="Project ID" error={errors['config.projectId']} hint="From the Firebase console." required>` |
| 835 | `<Field label="API base URL" error={errors['config.apiBase']} hint="Leave the default unless you use a proxy.">` |
| 838 | `<Field label="Token URL" error={errors['config.tokenUrl']} hint="Google's OAuth token endpoint.">` |
| 843 | `legend="Service account"` |
| 850 | `<Field label="Client email" error={errors['secrets.clientEmail']} required={!editing}>` |
| 854 | `label="Private key"` |
| 857 | `hint="Paste the whole key, including the BEGIN and END lines."` |
| 866 | `<Field label="Private key ID" hint="Optional. Helps identify the key in Google's audit logs.">` |
| 875 | `<FieldGroup legend="Apple settings">` |
| 877 | `<Field label="Team ID" error={errors['config.teamId']} hint="10 characters, from your Apple developer account." required>` |
| 880 | `<Field label="Key ID" error={errors['config.keyId']} hint="10 characters, shown next to the .p8 key." required>` |
| 884 | `<Field label="Topic" error={errors['config.topic']} hint="The app bundle ID, for example com.example.app." required>` |
| 887 | `<Field label="Environment">` |
| 889 | `<option value="production">Production</option>` |
| 890 | `<option value="sandbox">Sandbox</option>` |
| 893 | `<Field label="API base URL" error={errors['config.apiBase']} hint="Optional. Leave it empty to use Apple's default endpoint.">` |
| 914 | `Push messages are written to the server log and are not delivered. Use it to test journeys without a push service.` |
| 929 | `const list = useApi(() => api.call('pushProviders.list', {}), []);` |
| 932 | `const [editing, setEditing] = useState<Push \| 'new' \| null>(null);` |
| 938 | `await api.call('pushProviders.update', { id: p.id, enabled: !p.enabled });` |
| 959 | `await api.call('pushProviders.delete', { id: p.id });` |
| 973 | `title="Push"` |
| 977 | `Add push provider` |
| 985 | `<Alert tone="bad" title="Couldn't load push providers" onRetry={list.reload}>` |
| 992 | `title="No push provider yet"` |
| 999 | `Add web push for browsers, Firebase for Android or Apple Push Notification service for Apple apps. Until then, push steps in` |
| 1004 | `<Table label="Push providers">` |
| 1008 | `<Th className="hidden md:table-cell">Adapter</Th>` |
| 1020 | `{p.adapter === 'webpush' && typeof p.config.publicKey === 'string' && (` |
| 1021 | `<CopyInline value={p.config.publicKey} label={′Copy public key for ${p.name}′} />` |
| 1122 | `const [f, setF] = useState<AiForm>(() => aiFormOf(provider));` |
| 1127 | `const set = <K extends keyof AiForm>(key: K, value: AiForm[K]) => setF((cur) => ({ ...cur, [key]: value }));` |
| 1179 | `await api.call('aiProviders.update', {` |
| 1194 | `const created = await api.call('aiProviders.create', { ...input, apiKey: f.apiKey.trim() });` |
| 1210 | `title={provider ? ′Edit ${provider.name}′ : 'Add AI provider'}` |
| 1223 | `<Button variant="primary" type="submit" form="ai-provider-form" loading={saving}>` |
| 1241 | `label="API style"` |
| 1242 | `hint={editing ? 'The API style cannot be changed after the provider is added.' : 'Choose the API your model endpoint speaks.'}` |
| 1245 | `<option value="anthropic-compatible">Anthropic-compatible</option>` |
| 1246 | `<option value="openai-compatible">OpenAI-compatible</option>` |
| 1247 | `<option value="decision">Decision model (TypeSafe System One / JEV)</option>` |
| 1251 | `label="Base URL"` |
| 1253 | `hint="The API root, including the version path when the provider needs one."` |
| 1258 | `<FieldGroup legend="Models">` |
| 1260 | `label="Default model"` |
| 1262 | `hint="The model ID your provider expects, for example claude-sonnet-5-5."` |
| 1268 | `label="Fast model"` |
| 1270 | `hint="Optional. Used for short tasks such as classifying intent or picking a segment."` |
| 1275 | `label="Structured outputs"` |
| 1276 | `hint="Leave on when the model supports JSON schema responses. Turn off if it rejects them."` |
| 1283 | `label="Allow personal data"` |
| 1284 | `hint="Only when the provider is covered by a no-retention agreement. JEV through CommandCode has none; leave this off and scores use segment ids, event counts and non-personal traits."` |
| 1292 | `label="Monthly token budget"` |
| 1295 | `hint="Optional. AI steps stop when the budget is reached."` |
| 1299 | `<Field label="Region" error={errors.region} hint="Optional. Where your provider processes requests.">` |
| 1306 | `hint="Disabled providers are skipped by AI steps and the copilot."` |
| 1312 | `label="API key"` |
| 1335 | `const list = useApi(() => api.call('aiProviders.list', {}), []);` |
| 1338 | `const [editing, setEditing] = useState<Ai \| 'new' \| null>(null);` |
| 1344 | `await api.call('aiProviders.update', { id: p.id, enabled: !p.enabled });` |
| 1359 | `Journeys and the copilot will fail when they try to use this provider, until another one is chosen. The stored API key is deleted.` |
| 1369 | `await api.call('aiProviders.delete', { id: p.id });` |
| 1383 | `title="AI"` |
| 1387 | `Add AI provider` |
| 1395 | `<Alert tone="bad" title="Couldn't load AI providers" onRetry={list.reload}>` |
| 1402 | `title="No AI provider yet"` |
| 1409 | `Add an OpenAI- or Anthropic-compatible endpoint with your own API key to run AI steps in journeys and the copilot. Until then,` |
| 1410 | `AI steps take their fallback.` |
| 1414 | `<Table label="AI providers">` |
| 1418 | `<Th className="hidden md:table-cell">Models</Th>` |
| 1432 | `<div className="mt-0.5 max-w-[280px] truncate font-mono text-[11px] text-muted" title={p.baseUrl}>` |


### apps/web/src/features/providers/SchemaForm.tsx

[Baseline source](../../../apps/web/src/features/providers/SchemaForm.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 21 | `export function humanize(key: string): string {` |
| 88 | `label={label}` |
| 89 | `hint={s.description}` |
| 99 | `<Field key={key} label={label} hint={s.description} error={error} required={required.has(key)}>` |
| 101 | `{!required.has(key) && s.default === undefined && <option value="">Not set</option>}` |
| 103 | `<option key={String(o)} value={String(o)}>` |
| 112 | `<Field key={key} label={label} hint={hint \|\| undefined} error={error} required={required.has(key) && !keepHint}>` |


### apps/web/src/features/integrations/ConnectAgentCard.tsx

[Baseline source](../../../apps/web/src/features/integrations/ConnectAgentCard.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 6 | `<Card title="Connect an agent" description="Agents use the same commands as this UI, under the same rules: they draft, people approve.">` |
| 8 | `<CodeView value={′${location.origin}/mcp′} label="MCP server URL" />` |


### apps/web/src/features/integrations/ConnectionsCard.tsx

[Baseline source](../../../apps/web/src/features/integrations/ConnectionsCard.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 7 | `Alert,` |
| 8 | `Button,` |
| 9 | `Card,` |
| 10 | `Checkbox,` |
| 11 | `CodeView,` |
| 12 | `Drawer,` |
| 13 | `EmptyState,` |
| 14 | `Field,` |
| 15 | `FieldGroup,` |
| 17 | `Input,` |
| 18 | `LoadingBlock,` |
| 19 | `Menu,` |
| 20 | `Modal,` |
| 21 | `Select,` |
| 22 | `StatusPill,` |
| 23 | `Table,` |
| 24 | `TableFrame,` |
| 25 | `Tag,` |
| 26 | `Td,` |
| 27 | `THead,` |
| 28 | `Th,` |
| 29 | `Tr,` |
| 40 | `const OAUTH_LABEL: Record<'pending' \| 'connected' \| 'error', { label: string; tone: 'neutral' \| 'good' \| 'bad' }> = {` |
| 41 | `pending: { label: 'Not authorized', tone: 'neutral' },` |
| 42 | `connected: { label: 'Connected', tone: 'good' },` |
| 43 | `error: { label: 'Authorization failed', tone: 'bad' },` |
| 50 | `skip: boolean,` |
| 54 | `for (const key of schema.required ?? []) {` |
| 89 | `const [connectorId, setConnectorId] = useState(connection?.connector ?? initialConnector?.id ?? '');` |
| 91 | `const [name, setName] = useState(connection?.name ?? initialConnector?.label ?? '');` |
| 92 | `const [settings, setSettings] = useState<Record<string, unknown>>(() =>` |
| 97 | `const [secrets, setSecrets] = useState<Record<string, unknown>>({});` |
| 98 | `const [enabled, setEnabled] = useState(connection?.enabled ?? true);` |
| 99 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 100 | `const [error, setError] = useState<string \| null>(null);` |
| 101 | `const [saving, setSaving] = useState(false);` |
| 123 | `await api.call('connections.update', {` |
| 132 | `const created = await api.call('connections.create', {` |
| 165 | `title={connection ? ′Edit ${connection.name}′ : 'Add connection'}` |
| 176 | `Cancel` |
| 178 | `<Button variant="primary" type="submit" form="connection-form" loading={saving}>` |
| 192 | `<Field label="Connector" hint={connector?.description} error={errors.connector} required>` |
| 195 | `<option key={c.id} value={c.id}>` |
| 201 | `<Field label="Name" hint="How this connection appears in journeys and deliveries." error={errors.name} required>` |
| 207 | `<FieldGroup legend="Settings">` |
| 219 | `legend="Credentials"` |
| 220 | `hint={` |
| 242 | `label="Enabled"` |
| 243 | `hint="Disabled connections are skipped; journey steps that use them take their error edge."` |
| 252 | `title={` |
| 269 | `<Alert tone="bad" title={connection ? 'Not saved' : 'Not added'}>` |
| 280 | `const admin = can('workspace:admin');` |
| 281 | `const catalog = useApi(() => api.call('connectors.list', {}), []);` |
| 282 | `const list = useApi(() => api.call('connections.list', {}), []);` |
| 285 | `const [editing, setEditing] = useState<Connection \| 'new' \| null>(null);` |
| 286 | `const [inbound, setInbound] = useState<{ name: string; url: string } \| null>(null);` |
| 287 | `const [busy, setBusy] = useState<string \| null>(null);` |
| 300 | `const { url } = await api.call('connections.authorize', { id: c.id });` |
| 305 | `toast.error(errText(e));` |
| 313 | `title: ′Delete “${c.name}”?′,` |
| 326 | `await api.call('connections.delete', { id: c.id });` |
| 339 | `title="Connections"` |
| 349 | `loading={catalog.refreshing \|\| list.refreshing}` |
| 351 | `Refresh` |
| 354 | `Add connection` |
| 360 | `{catalog.loading \|\| list.loading ? (` |
| 362 | `) : (list.error ?? catalog.error) ? (` |
| 364 | `<Alert tone="bad" title="Couldn't load connections" onRetry={reload}>` |
| 365 | `{errText(list.error ?? catalog.error)}` |
| 371 | `title="No connections yet"` |
| 388 | `<Table label="Connections">` |
| 391 | `<Th>Name</Th>` |
| 392 | `<Th className="hidden md:table-cell">Connector</Th>` |
| 393 | `<Th>Status</Th>` |
| 394 | `{admin && <Th align="right">Actions</Th>}` |
| 419 | `{c.oauth?.status === 'error' && c.oauth.error && (` |
| 420 | `<span className="max-w-[220px] truncate text-[11px] text-bad" title={c.oauth.error}>` |
| 421 | `{c.oauth.error}` |
| 430 | `<Button size="sm" icon={<ExternalLink size={14} />} loading={busy === c.id} onClick={() => void authorize(c)}>` |
| 435 | `Edit` |
| 438 | `label={′More for ${c.name}′}` |
| 443 | `aria-label={′More for ${c.name}′}` |
| 451 | `label: 'Delete',` |
| 493 | `title={′Inbound URL for “${inbound?.name ?? ''}”′}` |
| 501 | `<CodeView value={inbound?.url ?? ''} label="Inbound webhook URL" maxHeight={100} />` |


### apps/web/src/features/integrations/JsonSchemaFields.tsx

[Baseline source](../../../apps/web/src/features/integrations/JsonSchemaFields.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useState } from 'react';` |
| 41 | `const [text, setText] = useState(() => textOf(value, schema));` |
| 42 | `const [parseError, setParseError] = useState<string \| null>(null);` |
| 58 | `<Field label={humanize(name)} hint={schema.description} error={parseError ?? error} required={required}>` |


### apps/web/src/features/integrations/SourcesCard.tsx

[Baseline source](../../../apps/web/src/features/integrations/SourcesCard.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 6 | `Alert,` |
| 7 | `Button,` |
| 8 | `Card,` |
| 9 | `CodeView,` |
| 10 | `Drawer,` |
| 11 | `EmptyState,` |
| 12 | `Field,` |
| 13 | `Input,` |
| 14 | `Menu,` |
| 15 | `Modal,` |
| 16 | `RadioCards,` |
| 17 | `Select,` |
| 18 | `Switch,` |
| 19 | `Table,` |
| 20 | `TableFrame,` |
| 21 | `Tag,` |
| 22 | `Td,` |
| 23 | `Textarea,` |
| 24 | `THead,` |
| 25 | `Th,` |
| 26 | `Tr,` |
| 35 | `const list = useApi(() => api.call('sources.list', {}), []);` |
| 38 | `const [editing, setEditing] = useState<Source \| 'new' \| null>(null);` |
| 39 | `const [secret, setSecret] = useState<{ name: string; key: string } \| null>(null);` |
| 45 | `title: ′Replace the key of “${s.name}”?′,` |
| 52 | `const r = await api.call('sources.rotateKey', { id: s.id });` |
| 53 | `setSecret({ name: s.name, key: r.key });` |
| 56 | `toast.error(errText(e));` |
| 61 | `title: ′Delete “${s.name}”?′,` |
| 69 | `await api.call('sources.delete', { id: s.id });` |
| 78 | `await api.call('sources.update', { id: s.id, enabled: !s.enabled });` |
| 87 | `title="Event sources"` |
| 91 | `Add source` |
| 96 | `loading={list.loading}` |
| 97 | `error={list.error}` |
| 102 | `title="No sources yet"` |
| 109 | `Add your website to collect page views and events with the browser SDK, consent first.` |
| 113 | `<Table label="Event sources">` |
| 116 | `<Th>Name</Th>` |
| 117 | `<Th>Kind</Th>` |
| 118 | `<Th className="hidden md:table-cell">Allowed sites</Th>` |
| 119 | `<Th>Consent needed</Th>` |
| 120 | `<Th>Enabled</Th>` |
| 121 | `<Th>` |
| 139 | `<Switch checked={s.enabled} onChange={() => void toggle(s)} label={′${s.name} enabled′} hideLabel />` |
| 143 | `label={′More for ${s.name}′}` |
| 145 | `{ label: 'Edit', onSelect: () => setEditing(s) },` |
| 146 | `{ label: 'Replace key', icon: <RefreshCw />, onSelect: () => void rotate(s) },` |
| 148 | `{ label: 'Delete', icon: <Trash2 />, destructive: true, onSelect: () => void remove(s) },` |
| 154 | `aria-label={′More actions for ${s.name}′}` |
| 170 | `label={′Browser SDK for “${browser.name}”′}` |
| 194 | `title={′Key for “${secret.name}”′}` |
| 217 | `onSaved: (created?: { name: string; key: string }) => void;` |
| 220 | `const purposes = useApi(() => api.call('purposes.list', {}), []);` |
| 221 | `const [kind, setKind] = useState<'browser' \| 'server'>(source?.kind ?? 'browser');` |
| 222 | `const [name, setName] = useState(source?.name ?? 'Website');` |
| 223 | `const [origins, setOrigins] = useState((source?.allowedOrigins ?? [location.origin]).join('\n'));` |
| 224 | `const [purpose, setPurpose] = useState<string>(source ? (source.requiredPurpose ?? '') : 'analytics');` |
| 225 | `const [error, setError] = useState<string \| null>(null);` |
| 226 | `const [busy, setBusy] = useState(false);` |
| 236 | `await api.call('sources.update', { id: source.id, name, allowedOrigins, requiredPurpose: purpose \|\| null });` |
| 240 | `const r = await api.call('sources.create', {` |
| 247 | `onSaved(kind === 'server' ? { name, key: r.key } : undefined);` |
| 259 | `title={source ? ′Edit “${source.name}”′ : 'Add an event source'}` |
| 263 | `Cancel` |
| 265 | `<Button variant="primary" className="ml-auto" icon={source ? undefined : <KeyRound size={14} />} loading={busy} onClick={save}>` |
| 279 | `{ value: 'browser', label: 'Website', hint: 'Public write key, only accepted from the sites you list.' },` |
| 280 | `{ value: 'server', label: 'Server', hint: 'Secret key for your backend or n8n; shown once.' },` |
| 284 | `<Field label="Name" required>` |
| 288 | `<Field label="Allowed sites" hint="One origin per line, e.g. https://example.com. Events from other sites are refused.">` |
| 293 | `label="Keep events only with consent for"` |
| 294 | `hint="Visitors who have not allowed this purpose send nothing that is kept. Websites usually use analytics."` |
| 297 | `<option value="">No consent check</option>` |
| 299 | `<option key={p.key} value={p.key}>` |
| 307 | `Without a consent check, website events are kept for every visitor. Most sites need consent for analytics.` |


### apps/web/src/features/integrations/WebhooksCard.tsx

[Baseline source](../../../apps/web/src/features/integrations/WebhooksCard.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 7 | `Alert,` |
| 8 | `Button,` |
| 9 | `Card,` |
| 10 | `CodeView,` |
| 11 | `Drawer,` |
| 12 | `EmptyState,` |
| 13 | `Field,` |
| 15 | `Input,` |
| 16 | `Menu,` |
| 17 | `Modal,` |
| 18 | `StatusPill,` |
| 19 | `Switch,` |
| 20 | `Table,` |
| 21 | `TableFrame,` |
| 22 | `Tag,` |
| 23 | `Td,` |
| 24 | `Textarea,` |
| 25 | `THead,` |
| 26 | `Th,` |
| 27 | `Tr,` |
| 89 | `const [f, setF] = useState<WebhookForm>(() => ({` |
| 95 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 96 | `const [error, setError] = useState<string \| null>(null);` |
| 97 | `const [saving, setSaving] = useState(false);` |
| 98 | `const set = <K extends keyof WebhookForm>(key: K, value: WebhookForm[K]) => setF((cur) => ({ ...cur, [key]: value }));` |
| 114 | `await api.call('webhooks.update', { id: endpoint.id, ...input });` |
| 117 | `const created = await api.call('webhooks.create', {` |
| 142 | `title={endpoint ? ′Edit ${endpoint.name}′ : 'Add endpoint'}` |
| 147 | `Cancel` |
| 149 | `<Button variant="primary" type="submit" form="webhook-form" loading={saving}>` |
| 163 | `<Field label="Name" hint="How this endpoint appears in deliveries and journey steps." error={errors.name} required>` |
| 167 | `label="Endpoint URL"` |
| 169 | `hint="An http:// or https:// address on the public internet. Private and local addresses are refused."` |
| 180 | `label="Events"` |
| 182 | `hint="Event names separated by commas or new lines, for example identify, order.completed, or * for every event. Leave empty to receive only journey webhook steps."` |
| 187 | `label="Purpose"` |
| 189 | `hint="Optional. When set, only events from people who consented to this purpose are sent, for example analytics."` |
| 194 | `<Alert tone="info" title="Signed requests">` |
| 200 | `<Alert tone="bad" title={endpoint ? 'Not saved' : 'Not added'}>` |
| 211 | `const admin = can('workspace:admin');` |
| 212 | `const list = useApi(() => api.call('webhooks.list', {}), []);` |
| 213 | `const deliveries = useApi(() => api.call('deliveries.list', { limit: 100 }), []);` |
| 216 | `const [editing, setEditing] = useState<Endpoint \| 'new' \| null>(null);` |
| 217 | `const [secret, setSecret] = useState<{ name: string; value: string } \| null>(null);` |
| 218 | `const [busy, setBusy] = useState<string \| null>(null);` |
| 219 | `const [retrying, setRetrying] = useState<string \| null>(null);` |
| 235 | `await api.call('webhooks.update', { id: e.id, enabled: !e.enabled });` |
| 241 | `toast.error(errText(err));` |
| 250 | `await api.call('webhooks.test', { id: e.id });` |
| 262 | `title: ′Delete “${e.name}”?′,` |
| 265 | `Events stop being sent to this URL and deliveries still waiting are dropped. The signing secret is deleted. Journey webhook steps` |
| 276 | `await api.call('webhooks.delete', { id: e.id });` |
| 289 | `await api.call('deliveries.retry', { id: d.id });` |
| 302 | `title="Webhooks"` |
| 307 | `Add endpoint` |
| 313 | `loading={list.loading}` |
| 314 | `error={list.error ? errText(list.error) : null}` |
| 321 | `title="No webhook endpoints yet"` |
| 336 | `<Table label="Webhook endpoints">` |
| 339 | `<Th>Name</Th>` |
| 340 | `<Th className="hidden lg:table-cell">URL</Th>` |
| 341 | `<Th className="hidden md:table-cell">Events</Th>` |
| 342 | `<Th>Last delivery</Th>` |
| 343 | `<Th>Status</Th>` |
| 344 | `{admin && <Th align="right">Actions</Th>}` |
| 357 | `<div className="mt-0.5 max-w-[260px] truncate font-mono text-[11px] text-muted lg:hidden" title={e.url}>` |
| 367 | `title={e.url}` |
| 374 | `<div className="max-w-[240px] truncate" title={e.events.join(', ')}>` |
| 397 | `label={′Enable ${e.name}′}` |
| 402 | `Edit` |
| 404 | `<Button size="sm" icon={<Send size={14} />} loading={busy === e.id} onClick={() => void sendTest(e)}>` |
| 405 | `Send test` |
| 408 | `label={′More for ${e.name}′}` |
| 413 | `aria-label={′More for ${e.name}′}` |
| 421 | `label: 'Delete',` |
| 441 | `title="Recent deliveries"` |
| 444 | `<Button variant="ghost" size="sm" icon={<RefreshCw size={14} />} onClick={deliveries.reload} loading={deliveries.refreshing}>` |
| 445 | `Refresh` |
| 450 | `loading={deliveries.loading}` |
| 451 | `error={deliveries.error ? errText(deliveries.error) : null}` |
| 458 | `title="No deliveries yet"` |
| 473 | `<Table label="Recent webhook deliveries">` |
| 477 | `<Th>Event</Th>` |
| 478 | `<Th className="hidden md:table-cell">Endpoint</Th>` |
| 479 | `<Th>Attempts</Th>` |
| 480 | `<Th className="hidden lg:table-cell">Response</Th>` |
| 481 | `<Th>When</Th>` |
| 500 | `{d.error && (` |
| 501 | `<div className="max-w-[220px] truncate text-[11px] text-muted" title={d.error}>` |
| 502 | `{d.error}` |
| 506 | `<Td className="whitespace-nowrap" title={d.createdAt}>` |
| 516 | `loading={retrying === d.id}` |
| 519 | `Retry` |
| 552 | `title={′Signing secret for “${secret?.name ?? ''}”′}` |
| 563 | `<CodeView value={secret?.value ?? ''} label="Signing secret" maxHeight={100} />` |


### apps/web/src/features/tokens/CreateTokenDrawer.tsx

[Baseline source](../../../apps/web/src/features/tokens/CreateTokenDrawer.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 27 | `const [name, setName] = useState('');` |
| 28 | `const [nameError, setNameError] = useState<string \| null>(null);` |
| 29 | `const [scopes, setScopes] = useState<string[]>(['artifacts:read']);` |
| 30 | `const [workspaceId, setWorkspaceId] = useState(currentWorkspaceId);` |
| 31 | `const [days, setDays] = useState('90');` |
| 32 | `const [error, setError] = useState<string \| null>(null);` |
| 33 | `const [busy, setBusy] = useState(false);` |
| 46 | `const r = await target.call('apiTokens.create', {` |
| 64 | `title="Create an API token"` |
| 69 | `Cancel` |
| 71 | `<Button variant="primary" className="ml-auto" icon={<KeyRound size={14} />} loading={busy} onClick={submit}>` |
| 72 | `Create token` |
| 84 | `<Field label="Name" hint="What uses it, e.g. “Hermes” or “n8n reporting”." error={nameError} required>` |
| 97 | `label="Brand"` |
| 98 | `hint="The token acts in this brand only. To let the same tool work in another brand, create a second token there."` |
| 102 | `<option key={m.id} value={m.id}>` |
| 112 | `<Field label="Expires" hint="Shorter is safer; an admin can extend it later with their password.">` |
| 114 | `<option value="30">In 30 days</option>` |
| 115 | `<option value="90">In 90 days</option>` |
| 116 | `<option value="365">In a year</option>` |
| 117 | `<option value="">Never</option>` |


### apps/web/src/features/tokens/ScopePicker.tsx

[Baseline source](../../../apps/web/src/features/tokens/ScopePicker.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 24 | `label={` |
| 29 | `hint={′Lets it ${SCOPE_TEXT[s].does}.′}` |
| 37 | `legend="Scopes"` |
| 38 | `hint="A token acts as an agent: never more than its owner's role allows, and never what only people may do."` |
| 43 | `<summary className="cursor-pointer text-muted hover:text-fg">Scopes that give a token nothing ({peopleOnly.length})</summary>` |


### apps/web/src/features/tokens/TokenDrawer.tsx

[Baseline source](../../../apps/web/src/features/tokens/TokenDrawer.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useMemo, useState } from 'react';` |
| 7 | `Alert,` |
| 8 | `Button,` |
| 9 | `DateTimeInput,` |
| 10 | `Drawer,` |
| 11 | `Field,` |
| 12 | `FieldGroup,` |
| 14 | `Input,` |
| 15 | `LoadingBlock,` |
| 16 | `Meta,` |
| 17 | `Mono,` |
| 18 | `Select,` |
| 53 | `const t = useApi(() => api.call('apiTokens.get', { id }), [id]);` |
| 54 | `const [name, setName] = useState('');` |
| 55 | `const [scopes, setScopes] = useState<string[]>([]);` |
| 56 | `const [expiryMode, setExpiryMode] = useState<'keep' \| 'never' \| 'date'>('keep');` |
| 57 | `const [expiresAt, setExpiresAt] = useState<string \| null>(null);` |
| 58 | `const [password, setPassword] = useState('');` |
| 59 | `const [error, setError] = useState<string \| null>(null);` |
| 60 | `const [busy, setBusy] = useState(false);` |
| 73 | `const editable = !!tok && can('workspace:admin') && !tok.revoked;` |
| 95 | `const r = await api.call('apiTokens.update', {` |
| 121 | `title: ′Revoke “${tok.name}”?′,` |
| 129 | `await api.call('apiTokens.revoke', { id: tok.id });` |
| 134 | `toast.error(errText(e));` |
| 138 | `const canRevoke = tok && !tok.revoked && (can('workspace:admin') \|\| tok.userId === user.id);` |
| 144 | `title={tok?.name ?? 'API token'}` |
| 157 | `Revoke` |
| 163 | `Discard` |
| 165 | `<Button variant="primary" disabled={!dirty} loading={busy} onClick={save}>` |
| 174 | `{t.loading ? (` |
| 176 | `) : t.error ? (` |
| 178 | `<Alert tone="bad" title="Couldn't open this token" onRetry={t.reload}>` |
| 179 | `{t.error}` |
| 195 | `{can('workspace:admin')` |
| 200 | `<Field label="Name" hint="What uses it, e.g. “Hermes” or “n8n reporting”.">` |
| 201 | `<Input value={name} onChange={(e) => setName(e.target.value)} readOnly={!editable} maxLength={120} />` |
| 204 | `<FieldGroup legend="Expiry">` |
| 205 | `<Field label="Expires" hideLabel>` |
| 207 | `<option value="keep">{tok.expiresAt ? ′Keep: ${formatDateTime(tok.expiresAt)}′ : 'Keep: never'}</option>` |
| 208 | `<option value="never">Never expires</option>` |
| 209 | `<option value="date">On a date…</option>` |
| 213 | `<Field label="Expires at" hint="Shortening applies at once; extending needs your password.">` |
| 221 | `<Alert tone="info" title="Applies at once">` |
| 245 | `<Field label="Your password" hint="Confirms it is you making this change." className="mt-3">` |
| 253 | `<Alert tone="bad" title="Not saved">` |


### apps/web/src/features/tokens/TokensCard.tsx

[Baseline source](../../../apps/web/src/features/tokens/TokensCard.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 8 | `Alert,` |
| 9 | `Button,` |
| 10 | `Card,` |
| 11 | `CodeView,` |
| 12 | `EmptyState,` |
| 14 | `Modal,` |
| 15 | `Mono,` |
| 16 | `Table,` |
| 17 | `TableFrame,` |
| 18 | `Tag,` |
| 19 | `Td,` |
| 20 | `THead,` |
| 21 | `Th,` |
| 22 | `Tr,` |
| 34 | `const list = useApi(() => api.call('apiTokens.list', {}), []);` |
| 35 | `const warnings = useApi(() => api.call('system.inputWarnings', {}), []);` |
| 36 | `const [creating, setCreating] = useState(false);` |
| 37 | `const [created, setCreated] = useState<{ name: string; token: string; workspaceName: string } \| null>(null);` |
| 39 | `const admin = can('workspace:admin');` |
| 44 | `title="API tokens"` |
| 52 | `Create token` |
| 65 | `loading={list.loading}` |
| 66 | `error={list.error}` |
| 71 | `title="No API tokens yet"` |
| 83 | `<Table label="API tokens">` |
| 86 | `<Th>Name</Th>` |
| 87 | `<Th>Brand</Th>` |
| 88 | `{admin && <Th>Owner</Th>}` |
| 89 | `<Th className="hidden lg:table-cell">Scopes</Th>` |
| 90 | `<Th>Last used</Th>` |
| 91 | `<Th className="hidden md:table-cell">Expires</Th>` |
| 92 | `<Th>Status</Th>` |
| 113 | `<summary className="cursor-pointer hover:text-fg">` |
| 163 | `title={′Token “${created.name}” created′}` |


### apps/web/src/features/tokens/scopes.ts

[Baseline source](../../../apps/web/src/features/tokens/scopes.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 21 | `export const SCOPE_TEXT: Record<Scope, { label: string; does: string; peopleOnly?: boolean; risky?: boolean }> = {` |
| 22 | `'artifacts:read': { label: 'Read artifacts', does: 'read journeys, templates, segments, forms and broadcasts' },` |
| 23 | `'artifacts:write': { label: 'Draft and edit', does: 'create and edit drafts (never live versions)' },` |
| 24 | `'artifacts:publish': { label: 'Submit for review', does: 'submit drafts; the approval policy decides whether a person must approve' },` |
| 26 | `label: 'Send messages',` |
| 30 | `'audit:read': { label: 'Read the audit log', does: 'read who did what' },` |
| 31 | `'profiles:read': { label: 'Read profiles', does: 'read profiles and events, without personal data' },` |
| 32 | `'profiles:pii': { label: 'See personal data', does: 'see e-mail addresses and other personal data', risky: true },` |
| 33 | `'profiles:write': { label: 'Update profiles', does: 'record consent and set traits', risky: true },` |
| 34 | `'secrets:read': { label: 'Use secret names', does: 'see the names of stored secrets (never their values)' },` |
| 35 | `'artifacts:approve': { label: 'Approve', does: 'nothing: only people can approve', peopleOnly: true },` |
| 36 | `'profiles:erase': { label: 'Erase people', does: 'nothing: only people can erase', peopleOnly: true },` |
| 37 | `'secrets:write': { label: 'Change secrets', does: 'nothing: only people can change secrets', peopleOnly: true },` |
| 39 | `label: 'Workspace settings',` |


## J · #528


### apps/web/src/pages/build/JourneyPage.tsx

[Baseline source](../../../apps/web/src/pages/build/JourneyPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 19 | `crumbs={[{ label: 'Journeys', to: '/marketing/journeys' }]}` |
| 26 | `key: 'report',` |
| 27 | `label: 'Report',` |


### apps/web/src/features/journey/Builder.tsx

[Baseline source](../../../apps/web/src/features/journey/Builder.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 3 | `Background,` |
| 5 | `Controls,` |
| 7 | `MarkerType,` |
| 8 | `MiniMap,` |
| 11 | `ReactFlow,` |
| 12 | `ReactFlowProvider,` |
| 17 | `BarChart3,` |
| 18 | `Copy,` |
| 19 | `Map as MapIcon,` |
| 20 | `Maximize,` |
| 21 | `Maximize2,` |
| 22 | `Minimize2,` |
| 23 | `PanelLeft,` |
| 24 | `PanelRight,` |
| 25 | `Plus,` |
| 26 | `Redo2,` |
| 27 | `Settings2,` |
| 28 | `ShieldCheck,` |
| 29 | `Trash2,` |
| 30 | `Undo2,` |
| 32 | `import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';` |
| 38 | `Button,` |
| 39 | `Checkbox,` |
| 40 | `ContextMenu,` |
| 42 | `EmptyState,` |
| 43 | `Field,` |
| 44 | `IconButton,` |
| 45 | `Input,` |
| 46 | `Kbd,` |
| 47 | `Menu,` |
| 49 | `Select,` |
| 50 | `Tabs,` |
| 51 | `Tag,` |
| 73 | `const prefKey = (scope: string, key: string) => ′am.journey.${scope}.${key}′;` |
| 74 | `function readPref<T>(scope: string, key: string, fallback: T): T {` |
| 82 | `function writePref(scope: string, key: string, value: unknown) {` |
| 99 | `function BuilderInner({ artifact, content, onChange, readOnly, warnings: serverWarnings }: EditorProps<JourneyContent>) {` |
| 105 | `const nodes = content.nodes ?? [];` |
| 106 | `const [sel, setSel] = useState<Sel>(null);` |
| 107 | `const [panel, setPanel] = useState<'inspect' \| 'check' \| 'simulate'>('inspect');` |
| 108 | `const [path, setPath] = useState<string[]>([]);` |
| 111 | `const [paletteOpen, setPaletteOpen] = useState(() => readPref(scope, 'palette', true));` |
| 112 | `const [inspectorOpen, setInspectorOpen] = useState(() => readPref(scope, 'inspector', true));` |
| 113 | `const [showMinimap, setShowMinimap] = useState(() => readPref(scope, 'minimap', true));` |
| 114 | `const [showStats, setShowStats] = useState(() => readPref(scope, 'stats', false));` |
| 115 | `const [fullscreen, setFullscreen] = useState(false);` |
| 116 | `const [canvasWide, setCanvasWide] = useState(true);` |
| 117 | `const [menu, setMenu] = useState<{ x: number; y: number; items: (MenuItem \| 'separator')[] } \| null>(null);` |
| 120 | `const [, bump] = useState(0);` |
| 136 | `const wantsStats = published && ((showStats && countsEligible) \|\| !!content.controlGroup);` |
| 137 | `const stats = useApi(() => api.call('journeys.stats', { artifactId: artifact.id }), [artifact.id, artifact.publishedVersion], {` |
| 138 | `skip: !wantsStats,` |
| 146 | `const setPref = (key: string, value: boolean, set: (v: boolean) => void) => {` |
| 221 | `draggable: !readOnly,` |
| 227 | `readOnly,` |
| 231 | `[nodes, positions, sel, readOnly, names, warnings, path],` |
| 233 | `const [rfNodes, setRfNodes] = useState<Node[]>(build);` |
| 259 | `label: e.label,` |
| 276 | `if (readOnly \|\| !sel) return;` |
| 283 | `if (readOnly) return;` |
| 301 | `label: 'Edit settings',` |
| 308 | `...(readOnly` |
| 312 | `label: 'Duplicate',` |
| 320 | `label: 'Delete step',` |
| 354 | `if (!readOnly) commit(disconnect(nodes, source!, Number(index)));` |
| 358 | `if (!readOnly)` |
| 364 | `label: 'Delete connection',` |
| 425 | `<aside aria-label="Step palette" className="hidden border-r border-line lg:block">` |
| 426 | `{!readOnly ? (` |
| 438 | `label={paletteOpen ? 'Hide step palette' : 'Show step palette'}` |
| 443 | `{!readOnly && (` |
| 447 | `label="Add step"` |
| 450 | `label: KINDS[k].label,` |
| 459 | `Add step` |
| 464 | `<IconButton label="Undo (Ctrl Z)" icon={<Undo2 size={15} />} onClick={undo} disabled={!past.current.length} />` |
| 465 | `<IconButton label="Redo (Ctrl Shift Z)" icon={<Redo2 size={15} />} onClick={redo} disabled={!future.current.length} />` |
| 466 | `<IconButton label="Delete selected (Del)" icon={<Trash2 size={15} />} onClick={removeSelection} disabled={!sel} />` |
| 469 | `<IconButton label="Fit to screen" icon={<Maximize size={15} />} onClick={() => rf.fitView({ padding: 0.2, duration: 200 })} />` |
| 472 | `label={showMinimap ? 'Hide minimap' : 'Show minimap'}` |
| 478 | `label={fullscreen ? 'Leave full screen (Esc)' : 'Full screen (F)'}` |
| 498 | `{content.controlGroup && (` |
| 500 | `Control {content.controlGroup.percent}%` |
| 505 | `label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}` |
| 526 | `if (!kind \|\| readOnly) return;` |
| 534 | `title="Start with a trigger"` |
| 536 | `!readOnly && (` |
| 538 | `Add a trigger` |
| 543 | `Drag steps from the left, or press them, to build the journey.` |
| 557 | `nodesConnectable={!readOnly}` |
| 618 | `aria-label={′Journey canvas, ${nodes.length} steps. Tab to a step, Enter to select it, Delete removes the selection, Shift F10 opens its menu.′}` |
| 641 | `<aside aria-label="Journey inspector" className={cx('min-h-0 border-t border-line lg:border-t-0 lg:border-l', 'flex flex-col')}>` |
| 644 | `label="Panel"` |
| 649 | `{ key: 'inspect', label: selectedNode ? 'Step' : 'Journey' },` |
| 650 | `{ key: 'check', label: 'Check', count: warnCount },` |
| 651 | `{ key: 'simulate', label: 'Simulate' },` |
| 663 | `readOnly={readOnly}` |
| 675 | `<JourneySettings content={content} onChange={onChange} readOnly={readOnly} published={published} stats={stats.data} />` |
| 701 | `<ContextMenu at={menu} items={menu?.items ?? []} onClose={() => setMenu(null)} label="Step actions" />` |
| 710 | `<EmptyState compact title="Ready to publish">` |
| 711 | `Every step has what it needs. Simulate it, then submit it for review.` |
| 741 | `readOnly: boolean;` |
| 745 | `return <JourneyMeta content={content} onChange={onChange} readOnly={readOnly} published={published} stats={stats} />;` |
| 761 | `const purposes = useApi(() => api.call('purposes.list', {}), []);` |
| 765 | `const cg = content.controlGroup;` |
| 771 | `<Field label="Purpose" hint="Every message in the journey is sent under this purpose's consent rules.">` |
| 772 | `<Select value={content.purpose} disabled={readOnly} onChange={(e) => onChange({ ...content, purpose: e.target.value })}>` |
| 773 | `{!purposes.data?.purposes.some((p) => p.key === content.purpose) && <option value={content.purpose}>{content.purpose}</option>}` |
| 775 | `<option key={p.key} value={p.key}>` |
| 781 | `<Field label="Goal" hint="What success looks like, for the team and for reports.">` |
| 783 | `value={content.goal ?? ''}` |
| 792 | `label="Control group"` |
| 793 | `hint="Hold back a share of entrants from every e-mail, SMS and push step, and still measure whether they reach the goal."` |
| 795 | `disabled={readOnly}` |
| 803 | `<Field label="Share in control" hint="1–50%. Assigned once per person per journey scope.">` |
| 813 | `<Field label="Minimum sample size" hint="Both arms need this many people before a verdict, default 200.">` |
| 833 | `label="Start a new scope if the percentage changes"` |
| 834 | `hint="Publishing a changed percentage after people were assigned is refused unless this is ticked. People keep their old arm."` |


### apps/web/src/features/journey/Inspector.tsx

[Baseline source](../../../apps/web/src/features/journey/Inspector.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 22 | `label: string;` |
| 27 | `<Field label={label} hint={hint}>` |
| 29 | `{!DURATIONS.includes(v) && <option value={v}>{v ? durationText(v) : 'Choose…'}</option>}` |
| 31 | `<option key={d} value={d}>` |
| 48 | `readOnly,` |
| 57 | `readOnly: boolean;` |
| 73 | `const webhooks = useApi(() => api.call('webhooks.list', {}), [], { skip: node.kind !== 'webhook' });` |
| 74 | `const connections = useApi(() => api.call('connections.list', {}), [], { skip: node.kind !== 'action' });` |
| 76 | `const planId = useApi(() => api.call('artifacts.list', { type: 'tracking_plan', limit: 1 }), [], {` |
| 77 | `skip: node.kind !== 'trigger' \|\| c.segment !== undefined,` |
| 82 | `return id ? api.call('artifacts.get', { artifactId: id }) : null;` |
| 85 | `{ skip: !planId.data?.artifacts[0] },` |
| 107 | `<Alert tone="warn" title="Incomplete">` |
| 115 | `<Field label="Label" hint="Shown on the canvas and in reports.">` |
| 116 | `<Input value={node.label} readOnly={readOnly} maxLength={120} onChange={(e) => onChange({ ...node, label: e.target.value })} />` |
| 120 | `<FieldGroup legend="Starts when">` |
| 122 | `label="Starts when"` |
| 125 | `!readOnly &&` |
| 129 | `{ key: 'event', label: 'An event happens' },` |
| 130 | `{ key: 'segment', label: 'Joins a segment' },` |
| 134 | `<Field label="Segment">` |
| 135 | `<ArtifactSelect type="segment" value={c.segment} disabled={readOnly} onChange={(v) => setC({ segment: v })} />` |
| 138 | `<Field label="Event name" hint='As sent by your site or forms, e.g. "Subscription Confirmed".'>` |
| 139 | `<Input value={c.event ?? ''} readOnly={readOnly} onChange={(e) => setC({ event: e.target.value })} />` |
| 144 | `legend="Entry key"` |
| 145 | `hint={` |
| 152 | `label="Entry key"` |
| 154 | `onChange={(v) => !readOnly && setEntryKey({ source: v })}` |
| 156 | `{ key: 'message_id', label: 'Message id' },` |
| 157 | `{ key: 'event_property', label: 'Event property' },` |
| 163 | `label="Property"` |
| 164 | `hint="A dot path into the event's properties, e.g. order_id or order.id. It must not change later."` |
| 168 | `readOnly={readOnly}` |
| 173 | `<Field label="When it is missing" hint="Empty or longer than 200 characters counts as missing.">` |
| 176 | `disabled={readOnly}` |
| 179 | `<option value="skip">Skip the entry</option>` |
| 180 | `<option value="message_id">Use the message id</option>` |
| 187 | `<Field label="Enter again">` |
| 188 | `<Select value={c.reentry ?? 'once'} disabled={readOnly} onChange={(e) => setC({ reentry: e.target.value })}>` |
| 189 | `<option value="once">{entryKey.source === 'event_property' ? 'Never: once per key' : 'Never: once per person'}</option>` |
| 190 | `<option value="after_exit">` |
| 193 | `<option value="always">Every time</option>` |
| 199 | `<Field label="Template" hint="It must be live before the journey can be published.">` |
| 209 | `<DurationSelect label="Wait for" value={c.duration} disabled={readOnly} onChange={(v) => setC({ duration: v })} />` |
| 213 | `<Field label="Event name">` |
| 218 | `label="Give up after"` |
| 219 | `hint="Then it takes the “timeout” path."` |
| 225 | `<DurationSelect label="Counts within" value={c.within} disabled={readOnly} onChange={(v) => setC({ within: v })} />` |
| 230 | `<FieldGroup legend="Until the person matches">` |
| 232 | `label="Wait until the person"` |
| 235 | `!readOnly && setC({ condition: v === 'segment' ? { segment: directSegment ?? '' } : { trait: 'city', op: 'eq', value: '' } })` |
| 238 | `{ key: 'segment', label: 'Is in a segment' },` |
| 239 | `{ key: 'condition', label: 'Matches a condition' },` |
| 251 | `label="Condition"` |
| 252 | `hint="A segment condition, e.g. {&quot;trait&quot;:&quot;plan&quot;,&quot;op&quot;:&quot;eq&quot;,&quot;value&quot;:&quot;pro&quot;}."` |
| 261 | `hint="At most 90 days. Then it takes the “timeout” path."` |
| 267 | `label="Check at least every"` |
| 268 | `hint="The fallback check, at least 5 minutes. Events and segment changes are checked at once."` |
| 276 | `<FieldGroup legend="Yes when the person…">` |
| 278 | `label="Yes when the person"` |
| 294 | `<ArtifactSelect type="segment" value={c.segment \|\| undefined} disabled={readOnly} onChange={(v) => setC({ segment: v })} />` |
| 298 | `hint="A segment condition, e.g. {&quot;trait&quot;:&quot;city&quot;,&quot;op&quot;:&quot;eq&quot;,&quot;value&quot;:&quot;Aarhus&quot;}."` |
| 308 | `<FieldGroup legend="Weights" hint="One per path; people are split at random by these weights.">` |
| 312 | `<Field label={′Path ${String.fromCharCode(65 + i)}′} unit="%" className="flex-1">` |
| 323 | `{all.length > 2 && !readOnly && (` |
| 326 | `aria-label={′Remove path ${String.fromCharCode(65 + i)}′}` |
| 333 | `{!readOnly && ((c.weights as number[]) ?? []).length < 5 && (` |
| 335 | `Add path` |
| 342 | `<Field label="Trait" hint="Letters, digits and _.">` |
| 343 | `<Input value={c.trait ?? ''} readOnly={readOnly} onChange={(e) => setC({ trait: e.target.value })} />` |
| 345 | `<Field label="Value" hint="Text, a number, true or false.">` |
| 360 | `label="Prompt"` |
| 364 | `: 'A generate prompt; its slots fill content.* for later e-mails.'` |
| 367 | `<ArtifactSelect type="prompt" value={c.prompt \|\| undefined} disabled={readOnly} onChange={(v) => setC({ prompt: v })} />` |
| 371 | `<Field label="Options" hint="The prompt's option keys, one per path, comma-separated.">` |
| 385 | `<Field label="Fallback" hint="Taken when the AI cannot decide (no consent, budget, timeout, error).">` |
| 386 | `<Select value={c.fallback ?? ''} disabled={readOnly} onChange={(e) => setC({ fallback: e.target.value })}>` |
| 388 | `<option key={o} value={o}>` |
| 397 | `label="Wait for the model at most"` |
| 406 | `<Field label="Endpoint" hint="Webhook endpoints are set up under Settings → Integrations.">` |
| 407 | `<Select value={c.endpoint ?? ''} disabled={readOnly} onChange={(e) => setC({ endpoint: e.target.value })}>` |
| 408 | `<option value="">{webhooks.loading ? 'Loading…' : 'Choose…'}</option>` |
| 410 | `<option key={w.id} value={w.id}>` |
| 416 | `<Field label="Payload (JSONata)" hint="Optional. Default: the profile id, non-personal traits and the trigger event.">` |
| 429 | `<Field label="Connection" hint="Connections are set up under Settings → Integrations.">` |
| 430 | `<Select value={c.connection ?? ''} disabled={readOnly} onChange={(e) => setC({ connection: e.target.value })}>` |
| 431 | `<option value="">{connections.loading ? 'Loading…' : 'Choose…'}</option>` |
| 433 | `<option key={x.id} value={x.id}>` |
| 439 | `<Field label="Action" hint='e.g. "postMessage" (Slack) or "request" (HTTP API).'>` |
| 440 | `<Input value={c.action ?? ''} readOnly={readOnly} onChange={(e) => setC({ action: e.target.value })} />` |
| 443 | `label="Input"` |
| 444 | `hint="A JSON object for the action."` |
| 454 | `<Field label="Store as" hint="Becomes vars.<name> for later steps.">` |
| 455 | `<Input value={c.set ?? ''} readOnly={readOnly} onChange={(e) => setC({ set: e.target.value })} />` |
| 457 | `<Field label="Expression (JSONata)" hint="Over {profile, event, vars, content, results}.">` |
| 458 | `<Textarea mono rows={3} value={c.expression ?? ''} readOnly={readOnly} onChange={(e) => setC({ expression: e.target.value })} />` |
| 464 | `<FieldGroup legend="Continues to" hint={outs > 1 ? 'Each outcome goes to one step.' : undefined}>` |
| 468 | `const disabled = readOnly \|\| i > (node.next?.length ?? 0);` |
| 475 | `label={label ? ′If ${label}′ : 'Next step'}` |
| 476 | `hint={i > (node.next?.length ?? 0) ? ′Connect “${edgeLabel(node, i - 1) ?? 'the previous outcome'}” first.′ : undefined}` |
| 479 | `<option value="">{current ? 'Disconnect' : 'Not connected'}</option>` |
| 481 | `<option key={t.id} value={t.id}>` |
| 491 | `{!readOnly && (` |
| 494 | `Duplicate` |
| 497 | `Delete step` |


### apps/web/src/features/journey/JourneyGraph.tsx

[Baseline source](../../../apps/web/src/features/journey/JourneyGraph.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 40 | `data: { node: n, summary: summary(n, names), warnings: warnings[n.id] ?? [], readOnly: true } satisfies NodeData,` |
| 56 | `label: e.label,` |
| 70 | `aria-label={′Journey graph with ${nodes.length} steps; the list below describes it′}` |
| 93 | `<summary className="cursor-pointer text-muted hover:text-fg">Steps as a list</summary>` |


### apps/web/src/features/journey/Legend.tsx

[Baseline source](../../../apps/web/src/features/journey/Legend.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 5 | `<ul aria-label="Step colours" className={className ?? 'flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-fg-2'}>` |


### apps/web/src/features/journey/NodeView.tsx

[Baseline source](../../../apps/web/src/features/journey/NodeView.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 15 | `readOnly?: boolean;` |
| 22 | `const { node, summary, warnings, stats, readOnly, highlight } = data as NodeData;` |
| 47 | `isConnectable={!readOnly}` |
| 62 | `<div className="mt-0.5 truncate text-[12px] text-fg-2" title={summary}>` |
| 70 | `<span className="inline-flex items-center gap-1 font-medium text-warn" title={warnings.join('\n')}>` |
| 75 | `<span className="text-muted tabular-nums" title={stats.label}>` |
| 96 | `title={label ? ′Connect “${label}”′ : 'Connect to the next step'}` |


### apps/web/src/features/journey/Palette.tsx

[Baseline source](../../../apps/web/src/features/journey/Palette.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 11 | `<nav aria-label="Steps" className="h-full overflow-y-auto p-2">` |
| 36 | `title={m.hint}` |


### apps/web/src/features/journey/SimulatePanel.tsx

[Baseline source](../../../apps/web/src/features/journey/SimulatePanel.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 29 | `const [events, setEvents] = useState<{ event: string; after: string }[]>([]);` |
| 30 | `const [branches, setBranches] = useState<Record<string, 'yes' \| 'no'>>({});` |
| 31 | `const [ai, setAi] = useState<Record<string, string>>({});` |
| 32 | `const [sampleName, setSampleName] = useState('');` |
| 33 | `const [sampleProperties, setSampleProperties] = useState('{}');` |
| 34 | `const [result, setResult] = useState<Result \| null>(null);` |
| 35 | `const [error, setError] = useState<string \| null>(null);` |
| 36 | `const [busy, setBusy] = useState(false);` |
| 38 | `const entryKey = trigger?.config.entryKey as { source?: string; property?: string } \| undefined;` |
| 47 | `name: sampleName \|\| String(trigger?.config.event ?? ''),` |
| 55 | `const r = await api.call('journeys.simulate', {` |
| 83 | `<Field label="Event" className="flex-1">` |
| 91 | `<Field label="After" className="w-[96px]">` |
| 98 | `<option key={d} value={d}>` |
| 107 | `aria-label="Remove event"` |
| 114 | `Add event` |
| 123 | `<Field label="Event name">` |
| 127 | `placeholder={String(trigger?.config.event ?? '')}` |
| 131 | `<Field label="Properties (JSON)" hint="For example {&quot;order_id&quot;:&quot;A-1&quot;}.">` |
| 140 | `<Field key={n.id} label={n.label}>` |
| 146 | `<option value="yes">Yes</option>` |
| 147 | `<option value="no">No</option>` |
| 160 | `value={ai[n.id] ?? String(n.config.fallback ?? '')}` |
| 163 | `{((n.config.options as string[]) ?? []).map((o) => (` |
| 164 | `<option key={o} value={o}>` |
| 173 | `<Button variant="primary" icon={<Play size={14} />} loading={busy} disabled={dirty} onClick={run}>` |
| 174 | `Run simulation` |
| 178 | `<section aria-label="Simulation result" className="space-y-2">` |
| 186 | `<Alert tone={result.entry.duplicate ? 'warn' : 'info'} title="Entry key">` |


### apps/web/src/features/journey/layout.ts

[Baseline source](../../../apps/web/src/features/journey/layout.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 55 | `if (!layout \|\| !content.nodes) return content;` |
| 56 | `return { ...content, nodes: content.nodes.map((n) => (layout[n.id] ? { ...n, position: layout[n.id] } : n)) };` |


### apps/web/src/features/journey/model.ts

[Baseline source](../../../apps/web/src/features/journey/model.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `Bell,` |
| 3 | `Bot,` |
| 4 | `Clock,` |
| 5 | `GitBranch,` |
| 6 | `Hourglass,` |
| 7 | `LogOut,` |
| 9 | `Mail,` |
| 10 | `MessageSquare,` |
| 11 | `Pencil,` |
| 12 | `Plug,` |
| 13 | `Shuffle,` |
| 14 | `Sparkles,` |
| 15 | `Target,` |
| 16 | `Variable,` |
| 17 | `Webhook,` |
| 18 | `Zap,` |
| 47 | `label: string;` |
| 61 | `export const CATEGORIES: { key: Category; label: string }[] = [` |
| 62 | `{ key: 'trigger', label: 'Trigger' },` |
| 63 | `{ key: 'message', label: 'Message' },` |
| 64 | `{ key: 'wait', label: 'Wait' },` |
| 65 | `{ key: 'logic', label: 'Branch and goal' },` |
| 66 | `{ key: 'ai', label: 'AI' },` |
| 67 | `{ key: 'action', label: 'Webhook and action' },` |
| 68 | `{ key: 'exit', label: 'Exit' },` |
| 71 | `export const KINDS: Record<NodeKind, { label: string; category: Category; icon: LucideIcon; hint: string }> = {` |
| 72 | `trigger: { label: 'Trigger', category: 'trigger', icon: Zap, hint: 'Who enters, and when' },` |
| 73 | `email: { label: 'E-mail', category: 'message', icon: Mail, hint: 'Send an e-mail template' },` |
| 74 | `sms: { label: 'SMS', category: 'message', icon: MessageSquare, hint: 'Send an SMS template' },` |
| 75 | `push: { label: 'Push', category: 'message', icon: Bell, hint: 'Send a push notification' },` |
| 76 | `wait: { label: 'Wait', category: 'wait', icon: Clock, hint: 'Pause for a while' },` |
| 77 | `waitEvent: { label: 'Wait for event', category: 'wait', icon: Hourglass, hint: 'Pause until an event or a timeout' },` |
| 78 | `waitUntil: { label: 'Wait until', category: 'wait', icon: Hourglass, hint: 'Hold until the person matches a condition, or the timeout' },` |
| 79 | `branch: { label: 'Branch', category: 'logic', icon: GitBranch, hint: 'Yes or no on a condition' },` |
| 80 | `split: { label: 'Split', category: 'logic', icon: Shuffle, hint: 'Random split by weight' },` |
| 81 | `goal: { label: 'Goal', category: 'logic', icon: Target, hint: 'Count a conversion' },` |
| 82 | `aiDecide: { label: 'AI decision', category: 'ai', icon: Bot, hint: 'A prompt picks the path' },` |
| 83 | `aiGenerate: { label: 'AI content', category: 'ai', icon: Sparkles, hint: 'A prompt writes content slots' },` |
| 84 | `webhook: { label: 'Webhook', category: 'action', icon: Webhook, hint: 'Post to a webhook endpoint' },` |
| 85 | `action: { label: 'Action', category: 'action', icon: Plug, hint: 'Run a connection action' },` |
| 86 | `updateProfile: { label: 'Update profile', category: 'action', icon: Pencil, hint: 'Set a trait' },` |
| 87 | `transform: { label: 'Transform', category: 'action', icon: Variable, hint: 'Compute a variable' },` |
| 88 | `exit: { label: 'Exit', category: 'exit', icon: LogOut, hint: 'Leave the journey' },` |
| 142 | `if (n.kind === 'split') return Math.max(2, ((n.config.weights as unknown[]) ?? []).length);` |
| 143 | `if (n.kind === 'aiDecide') return Math.max(2, ((n.config.options as unknown[]) ?? []).length);` |
| 151 | `if (n.kind === 'split') return ′${String.fromCharCode(65 + index)} · ${((n.config.weights as number[]) ?? [])[index] ?? 0}%′;` |
| 152 | `if (n.kind === 'aiDecide') return ((n.config.options as string[]) ?? [])[index];` |
| 165 | `if (n.next) return n.next.map((e, k) => ({ source: n.id, target: e.to, index: k, label: edgeLabel(n, k) }));` |
| 167 | `return n.kind !== 'exit' && following ? [{ source: n.id, target: following.id, index: 0, label: edgeLabel(n, 0) }] : [];` |
| 177 | `.map((e) => (n.next?.[e.index]?.label ? { to: e.target, label: n.next[e.index]!.label } : { to: e.target })),` |


### apps/web/src/features/journey/ops.ts

[Baseline source](../../../apps/web/src/features/journey/ops.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 26 | `out.push({ id, kind, label: KINDS[kind].label, config: structuredClone(DEFAULTS[kind]), next: [], position });` |
| 43 | `src.next![index] = { ...(src.next![index]?.label ? { label: src.next![index]!.label } : {}), to: target };` |
| 57 | `out.push({ id, kind: 'exit', label: 'Exit', config: {}, next: [], position: { x: at.x + 40 * index, y: at.y + NODE_H + 80 } });` |
| 86 | `label: ′${src.label} (copy)′,` |


## R · #529


### packages/artifacts/src/hostedPages.ts

[Baseline source](../../../packages/artifacts/src/hostedPages.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 11 | `export const DEFAULT_BRAND_COLORS = {` |
| 20 | `export type BrandColor = keyof typeof DEFAULT_BRAND_COLORS;` |
| 24 | `export const DEFAULT_BRAND_COPY = {` |
| 39 | `export type ResolvedCopy = { -readonly [K in keyof typeof DEFAULT_BRAND_COPY]: string };` |
| 42 | `const copy: ResolvedCopy = { ...DEFAULT_BRAND_COPY };` |
| 45 | `for (const key of Object.keys(DEFAULT_BRAND_COPY) as (keyof ResolvedCopy)[]) {` |
| 80 | `const colors: Record<BrandColor, string> = { ...DEFAULT_BRAND_COLORS };` |
| 83 | `for (const key of Object.keys(DEFAULT_BRAND_COLORS) as BrandColor[]) {` |
| 149 | `key: string;` |
| 196 | `const error = ctx.error ? ′<p class="error" role="alert">${escapeHtml(ctx.error)}</p>′ : '';` |
| 250 | `.error{margin:0 0 1rem;padding:.65rem .85rem;border:1px solid var(--text);border-radius:var(--radius);color:var(--text)}` |
| 277 | `const pages: Record<HostedPageKind, { title: string; body: string; button?: string }> = {` |
| 278 | `confirm: { title: copy.confirmTitle, body: copy.confirmBody, button: copy.confirmButton },` |
| 279 | `confirmed: { title: copy.confirmedTitle, body: copy.confirmedBody },` |
| 280 | `expired: { title: copy.expiredTitle, body: copy.expiredBody },` |
| 281 | `unsubscribe: { title: copy.unsubscribeTitle, body: copy.unsubscribeBody, button: copy.unsubscribeButton },` |
| 282 | `unsubscribed: { title: copy.unsubscribedTitle, body: copy.unsubscribedBody },` |


### packages/artifacts/src/types.ts

[Baseline source](../../../packages/artifacts/src/types.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 10 | `title: z.string().min(1).max(200),` |
| 40 | `label: z.string().min(1).max(120),` |
| 46 | `.array(z.object({ to: z.string(), label: z.string().max(40).optional() }))` |
| 82 | `key: DecisionKey,` |
| 224 | `prompt: PromptRef.describe("A generate prompt (prm_…); its slots fill ′content.<slot>′ for later e-mails, or the slot's fallback text"),` |
| 323 | `for (const issue of r.error.issues) {` |
| 409 | `key: TopicKey.describe('Stable key used by templates, broadcasts and segments, e.g. "newsletter"'),` |
| 418 | `key: Key.describe('Used in journeys, messages and consent signals, e.g. "marketing_email"'),` |
| 453 | `// {% block 'blk_…', key: value %}. Parameters are typed so a block can be reused across issues` |
| 456 | `key: z` |
| 460 | `label: z.string().min(1).max(120).describe('Shown next to the value when a person fills it in'),` |
| 475 | `"An MJML fragment (mj-section/mj-column), not a whole <mjml> document. Parameters are Liquid under block.*, e.g. {{ block.title }}; profile.*, unsubscribe_url and the other template variables also work. Use it in a template with {% block 'blk_…', title: 'This week' %}. Blocks cannot use other blocks in v1.",` |
| 500 | `"MJML with Liquid. Variables: profile.*, event.*, unsubscribe_url, preferences_url, topic_unsubscribe_url (when the template has a topic), web_url (a signed “view in browser” link). Reusable blocks: {% block 'blk_…', key: value %}.",` |
| 531 | `title: z` |
| 679 | `\| { score: { key: string; gte?: number; lte?: number } }` |
| 950 | `.array(z.object({ key: OptionKey, description: z.string().min(1).max(500) }))` |
| 967 | `.describe('generate: the content slots; templates use them as {{ content.<name> }}'),` |
| 1113 | `title: z.string().max(120).optional().describe('Archive title; defaults to the site name'),` |
| 1396 | `'content.publish',` |
| 1536 | `.array(z.object({ label: z.string().max(120), url: z.string().url() }))` |
| 1551 | `title: z.string().max(500).optional(),` |
| 1645 | `key: z.string().trim().min(1).max(2000).describe('The key message or angle; the plan uses it as the template subject and body seed'),` |
| 1717 | `// artifacts so people review and publish them like any other content. Only a published version is` |
| 1720 | `title: z.string().trim().min(1).max(200).describe('What the skill is called, e.g. "Subject lines that get opened"'),` |
| 1732 | `note: { prefix: 'not', label: 'Note', description: 'Free-form note, used to exercise the artifact system.', content: note },` |
| 1735 | `label: 'Journey',` |
| 1742 | `label: 'E-mail block',` |
| 1744 | `"A reusable MJML fragment with typed parameters, e.g. a header, footer or CTA. Templates include its published version with {% block 'blk_…', key: value %}; parameters are Liquid under block.* (html values are inserted raw, others escaped). Preview it with blocks.preview; see where it is used with blocks.usage. A template can be published only when its blocks are published; submit a new block and its template together with artifacts.requestPublishBundle.",` |
| 1749 | `label: 'E-mail template',` |
| 1755 | `label: 'SMS template',` |
| 1761 | `label: 'Push template',` |
| 1768 | `label: 'Segment',` |
| 1775 | `label: 'Web experience',` |
| 1782 | `label: 'AI prompt',` |
| 1789 | `label: 'Signup form',` |
| 1796 | `label: 'Brand',` |
| 1804 | `label: 'Broadcast',` |
| 1811 | `label: 'Campaign',` |
| 1818 | `label: 'Tracking plan',` |
| 1826 | `label: 'Purposes',` |
| 1834 | `label: 'Conversion map',` |
| 1842 | `label: 'Audience sync',` |
| 1849 | `label: 'Delivery policy',` |
| 1857 | `label: 'Agent mandate',` |
| 1865 | `label: 'Business context',` |
| 1873 | `label: 'Campaign brief',` |
| 1880 | `label: 'Content brief',` |
| 1887 | `label: 'Skill',` |
| 1897 | `key: 'necessary',` |
| 1906 | `key: 'analytics',` |
| 1915 | `key: 'web_personalization',` |
| 1924 | `key: 'onboarding',` |
| 1933 | `key: 'marketing_email',` |
| 1942 | `key: 'marketing_sms',` |
| 1951 | `key: 'service_sms',` |
| 1960 | `key: 'marketing_push',` |
| 1969 | `key: 'service_push',` |
| 1978 | `key: 'ad_measurement',` |
| 1987 | `key: 'ad_targeting',` |
| 1996 | `key: 'ai_processing',` |


### packages/audience/src/forms.ts

[Baseline source](../../../packages/audience/src/forms.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 6 | `DEFAULT_PURPOSES,` |
| 100 | `return v ? { version: number, def: artifactTypes.form.content.parse(v.content) as FormDefinition } : null;` |
| 110 | `key: string,` |
| 211 | `app.options('/f/:id', (c) =>` |
| 221 | `app.post(` |
| 239 | `const target = ok ? form.def.successUrl : (form.def.errorUrl ?? form.def.successUrl);` |
| 320 | `app.get('/f/confirm/:token', async (c) => {` |
| 327 | `app.post('/f/confirm/:token', async (c) => {` |


### packages/audience/src/hostedPages.ts

[Baseline source](../../../packages/audience/src/hostedPages.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 5 | `HOSTED_PAGE_KINDS,` |
| 22 | `title: 'Preview a hosted page',` |


### packages/audience/src/archive.ts

[Baseline source](../../../packages/audience/src/archive.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 39 | `title: string \| null;` |
| 57 | `const parsed = artifactTypes.brand.content.safeParse(row.content);` |
| 140 | `const live = artifactTypes.broadcast.content.safeParse(await versionContent(tx, run.broadcastId, run.publishedVersion));` |
| 143 | `const sent = artifactTypes.broadcast.content.safeParse(await versionContent(tx, run.broadcastId, run.version));` |
| 168 | `const template = artifactTypes.email_template.content.safeParse(await versionContent(tx, sent.data.template, templateVersion));` |
| 212 | `title: archive?.title ?? null,` |
| 292 | `title: string;` |
| 397 | `? ′<nav class="pager" aria-label="Archive pages">` |
| 464 | `title: subject,` |
| 555 | `app.get('/n/:slug/feed.xml', async (c) => {` |
| 565 | `app.get('/n/:slug/sitemap.xml', async (c) => {` |
| 575 | `app.get('/n/:slug', async (c) => {` |
| 581 | `app.get('/n/:slug/', async (c) => {` |
| 590 | `app.get('/n/:slug/:issue', async (c) => {` |
| 613 | `const template = artifactTypes.email_template.content.safeParse(` |
| 658 | `const sent = artifactTypes.broadcast.content.safeParse(await versionContent(tx, issue.artifactId, run.version));` |
| 721 | `name: 'archive.issues',` |
| 722 | `title: 'Newsletter archive issues',` |
| 729 | `title: z.string().nullable(),` |


### packages/email/src/routes.ts

[Baseline source](../../../packages/email/src/routes.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 3 | `DEFAULT_PURPOSES,` |
| 4 | `HOSTED_PAGE_HEADERS,` |
| 71 | `app.post('/hooks/email/:id/:token', bodyLimit(WEBHOOK_MAX_BODY, WEBHOOK_TOO_LARGE), async (c) => {` |
| 164 | `key: p.key,` |
| 168 | `key: t.key,` |
| 204 | `app.get('/u/:token', async (c) => {` |
| 210 | `app.post('/u/:token', async (c) => {` |
| 222 | `app.get('/u/p/:token', async (c) => {` |
| 231 | `app.post('/u/p/:token', bodyLimit(PREFERENCES_MAX_BODY, PREFERENCES_TOO_LARGE), async (c) => {` |
| 278 | `app.get('/u/t/:token', async (c) => {` |
| 296 | `app.post('/u/t/:token', bodyLimit(PREFERENCES_MAX_BODY, PREFERENCES_TOO_LARGE), async (c) => {` |
| 322 | `app.get('/c/:token', async (c) => {` |


### packages/email/src/render.ts

[Baseline source](../../../packages/email/src/render.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 92 | `/** ′{% block 'blk_…', title: 'This week' %}′ inlines the block's published MJML at render time. */` |
| 130 | `return { html: pngRenditionUrls(out.html), warnings: out.errors.map((e) => ′mjml line ${e.line}: ${e.message}′) };` |
| 205 | `for (const e of r.errors.slice(0, 10)) problems.push(′mjml line ${e.line}: ${e.message}′);` |


### packages/artifacts/recipes/lead-magnet-drip.json

[Baseline source](../../../packages/artifacts/recipes/lead-magnet-drip.json) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 70 | `"purpose": "{{param.purpose}}",` |
| 83 | `"subject": "Here is {{param.magnetName}}",` |
| 84 | `"preheader": "The download, plus what arrives over the next week.",` |
| 86 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>Thanks for asking for {{param.magnetName}}. You can download it here:</mj-text><mj-button href=\"{{param.magnetUrl}}\" background-color=\"#1d4ed8\" color=\"#ffffff\">Download {{param.magnetName}}</mj-button><mj-text>Over the next week I will send three short notes: how to use it, one example, and an invitation to go further.</mj-text></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">You get this because you downloaded {{param.magnetName}} from {{param.siteName}}. <a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |
| 96 | `"subject": "One way to use {{param.magnetName}} this week",` |
| 97 | `"preheader": "A small exercise, not a big project.",` |
| 99 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>The fastest way to get value from {{param.magnetName}} is to use one part of it this week, not all of it.</mj-text><mj-text>Pick the item that made you wince. Write down why. Change only that one thing before Friday.</mj-text><mj-text>That is the whole exercise.</mj-text></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\"><a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |
| 109 | `"subject": "What this looks like in practice",` |
| 110 | `"preheader": "A before-and-after from a real workspace.",` |
| 112 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>Here is what {{param.magnetName}} looks like when a team uses it.</mj-text><mj-text>Before: the same message went to everyone, once, with no follow-up.<br />After: one welcome, one useful follow-up and a clear unsubscribe. Less sending, more replies.</mj-text><mj-text>If you want the longer version, reply and I will send it.</mj-text></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\"><a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |
| 122 | `"subject": "Want to go one step further?",` |
| 123 | `"preheader": "A short call, or nothing at all.",` |
| 125 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>If {{param.magnetName}} was useful, the next step is a short conversation about your setup. No pitch: bring one question and we will work through it.</mj-text><mj-button href=\"{{param.siteUrl}}\" background-color=\"#1d4ed8\" color=\"#ffffff\">Book a time</mj-button><mj-text>If now is not the moment, stay on the list. The next note will be just as short.</mj-text></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">You get this because you downloaded {{param.magnetName}}. <a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |


### packages/artifacts/recipes/weekly-newsletter.json

[Baseline source](../../../packages/artifacts/recipes/weekly-newsletter.json) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 72 | `"purpose": "{{param.purpose}}",` |
| 95 | `"subject": "{{param.subject}}",` |
| 96 | `"preheader": "The week in marketing technology, in one short read.",` |
| 99 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">{{param.siteName}} · weekly</mj-text><mj-text font-size=\"22px\" font-weight=\"bold\">{{param.issueTitle}}</mj-text><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>This week: one thing worth knowing, one thing worth trying and one question worth asking.</mj-text><mj-text><strong>Worth knowing.</strong> Replace this paragraph with the week's main item.</mj-text><mj-text><strong>Worth trying.</strong> Replace this paragraph with one concrete step a reader can take.</mj-text><mj-text><strong>Worth asking.</strong> Reply with the question you want answered next.</mj-text><mj-button href=\"{{ web_url \| raw }}\" background-color=\"#1d4ed8\" color=\"#ffffff\">Read this issue in the browser</mj-button></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">You get this because you subscribed to {{param.siteName}}. <a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |
| 115 | `"docs": "## What this installs\n\nA dynamic subscriber segment (consent for the purpose), this issue's e-mail template and the broadcast that sends it.\n\n## Before publishing\n\n1. Edit the three paragraphs in the template with this week's content.\n2. Set ′sendAt′ if the issue should go at a fixed time; without it the broadcast sends as soon as it is published.\n3. Submit the template and the broadcast together with ′artifacts.requestPublishBundle′, so a person reviews the issue once; the broadcast can only publish after its template and segment are published.\n4. Check the audience with ′broadcasts.preview′ before the send.\n\n## Next week\n\nCopy this issue's template as the starting point for the next one; a sent broadcast is a record and should not be reused.",` |


### packages/artifacts/recipes/welcome-doi.json

[Baseline source](../../../packages/artifacts/recipes/welcome-doi.json) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 53 | `"purpose": "{{param.purpose}}",` |
| 65 | `"purpose": "onboarding",` |
| 66 | `"subject": "Confirm your subscription to {{param.siteName}}",` |
| 67 | `"preheader": "One click and you are in.",` |
| 69 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>Please confirm that you want to hear from {{param.siteName}}.</mj-text><mj-button href=\"{{ confirm_url \| raw }}\" background-color=\"#1d4ed8\" color=\"#ffffff\">Yes, subscribe me</mj-button><mj-text font-size=\"12px\" color=\"#6b7280\">If you did not sign up, you can ignore this e-mail.</mj-text></mj-column></mj-section></mj-body></mjml>"` |
| 79 | `"subject": "Welcome to {{param.siteName}}",` |
| 80 | `"preheader": "Thanks for confirming. Here is how to get the most from us.",` |
| 82 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>Welcome to {{param.siteName}}. You are on the list, and we are glad you are here.</mj-text><mj-text>Every issue is short: what changed, why it matters and what to do about it.</mj-text></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">You get this because you confirmed your subscription. <a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |
| 92 | `"subject": "Start here: the three things worth reading",` |
| 93 | `"preheader": "A short list to make the next issue useful.",` |
| 95 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>If you only read three things from {{param.siteName}}, start with these:</mj-text><mj-text>1. The guide that explains the basics.<br />2. The teardown that shows it in practice.<br />3. The checklist you can use this week.</mj-text><mj-text>Reply if you want us to cover something specific.</mj-text></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">You get this because you confirmed your subscription. <a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |


### packages/artifacts/recipes/win-back.json

[Baseline source](../../../packages/artifacts/recipes/win-back.json) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 52 | `"purpose": "{{param.purpose}}",` |
| 81 | `"subject": "Did something change?",` |
| 82 | `"preheader": "A quick question, and no hard feelings either way.",` |
| 84 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>It has been a while since your last order from {{param.siteName}}. Did something change: the product, the price, or what you needed?</mj-text><mj-text>Reply with one line and I will make sure it reaches the right person. If you would rather not hear from us again, the unsubscribe link below is enough.</mj-text></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">You get this because you bought from {{param.siteName}} and allowed marketing e-mail. <a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |
| 94 | `"subject": "A way back, if you want it",` |
| 95 | `"preheader": "A small offer and a clear exit.",` |
| 97 | `"mjml": "<mjml><mj-head><mj-attributes><mj-all font-family=\"Helvetica, Arial, sans-serif\" /></mj-attributes></mj-head><mj-body><mj-section><mj-column><mj-text>Hi {{ profile.firstName \| default: \"there\" }},</mj-text><mj-text>No pressure: if you have been meaning to come back, this is a good week. Use the code <strong>{{param.offerCode}}</strong> at checkout.</mj-text><mj-text>If not, that is useful to know too. The unsubscribe link is below and it takes one click.</mj-text><mj-button href=\"{{ web_url \| raw }}\" background-color=\"#1d4ed8\" color=\"#ffffff\">Visit {{param.siteName}}</mj-button></mj-column></mj-section><mj-section><mj-column><mj-text font-size=\"12px\" color=\"#6b7280\">You get this because you bought from {{param.siteName}} and allowed marketing e-mail. <a href=\"{{ preferences_url \| raw }}\">Manage preferences</a> or <a href=\"{{ unsubscribe_url \| raw }}\">unsubscribe</a>.</mj-text></mj-column></mj-section></mj-body></mjml>"` |


## D · #530


### apps/web/src/App.tsx

[Baseline source](../../../apps/web/src/App.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 18 | `const nav: { route: Route; label: string; icon: typeof Workflow }[] = [` |
| 19 | `{ route: 'overview', label: 'Overview', icon: LayoutDashboard },` |
| 20 | `{ route: 'live', label: 'Live site demo', icon: Globe },` |
| 21 | `{ route: 'journeys', label: 'Journeys', icon: Workflow },` |
| 22 | `{ route: 'email', label: 'E-mail templates', icon: Mail },` |
| 23 | `{ route: 'profiles', label: 'Profiles', icon: Users },` |
| 24 | `{ route: 'analytics', label: 'Analytics', icon: BarChart3 },` |
| 25 | `{ route: 'approvals', label: 'Approvals', icon: CheckCircle2 },` |
| 26 | `{ route: 'setup', label: 'Channels & MCP', icon: PlugZap },` |
| 58 | `aria-label="Toggle copilot"` |
| 86 | `Sign in to your workspace` |
| 141 | `<button type="button" onClick={() => dismissToast(t.id)} aria-label="Dismiss">` |


### apps/web/src/screens/Analytics.tsx

[Baseline source](../../../apps/web/src/screens/Analytics.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useState } from 'react';` |
| 11 | `const [jid, setJid] = useState<(typeof funnelJourneys)[number]>('jrn_cart');` |
| 19 | `<PageHeader eyebrow="Built-in analytics · ClickHouse" title="Analytics">` |
| 24 | `<Kpi label="Events ingested" value={′${(sum('events') / 1e6).toFixed(2)} M′} />` |
| 25 | `<Kpi label="Delivered" value={′${((sum('delivered') / sum('sent')) * 100).toFixed(1)}%′} />` |
| 26 | `<Kpi label="Click rate" value={′${((sum('clicks') / sum('sent')) * 100).toFixed(2)}%′} delta={-0.4} />` |
| 27 | `<Kpi label="Unsubscribe" value={′${((sum('unsubscribes') / sum('sent')) * 100).toFixed(2)}%′} />` |
| 28 | `<Kpi label="Orders" value={sum('conversions').toLocaleString('en')} delta={7.9} />` |
| 29 | `<Kpi label="Revenue" value={dkk(sum('revenue'))} delta={11.3} />` |
| 33 | `<Card title="E-mail engagement per day">` |
| 68 | `title="Journey funnel"` |
| 106 | `label: {` |
| 124 | `<Card title="Experiment: cart reminder incentive (A/B)">` |
| 152 | `<Card title="Web personalization">` |


### apps/web/src/screens/Approvals.tsx

[Baseline source](../../../apps/web/src/screens/Approvals.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 9 | `const policies: { id: ApprovalPolicy; label: string; text: string }[] = [` |
| 10 | `{ id: 'none', label: 'No approvals', text: 'Single-person workspace: publish directly.' },` |
| 11 | `{ id: 'agent_changes', label: 'Agent changes need a human', text: 'People publish directly; anything an agent wrote waits for review.' },` |
| 12 | `{ id: 'all_publishes', label: 'Every publish needs approval', text: 'Teams with a review step for all changes.' },` |
| 17 | `const [openId, setOpenId] = useState<string \| null>(approvals.find((a) => a.status === 'pending')?.id ?? null);` |
| 32 | `<PageHeader eyebrow="Versioning & governance" title="Approvals" />` |
| 34 | `<Card title="Workspace approval policy" className="mb-5">` |
| 57 | `<Card title="Requests">` |
| 95 | `title={` |
| 149 | `Open in journey builder` |


### apps/web/src/screens/EmailEditor.tsx

[Baseline source](../../../apps/web/src/screens/EmailEditor.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useRef, useState } from 'react';` |
| 15 | `const [templateId, setTemplateId] = useState(templates[0].id);` |
| 17 | `const [mode, setMode] = useState<Mode>('visual');` |
| 18 | `const [source, setSource] = useState(template.mjml);` |
| 19 | `const [subject, setSubject] = useState(template.subject);` |
| 20 | `const [profileId, setProfileId] = useState(profiles[0].id);` |
| 21 | `const [variant, setVariant] = useState<'A' \| 'B'>('A');` |
| 22 | `const [preview, setPreview] = useState({ html: '', subject: '', error: '' });` |
| 63 | `if (label) b.set({ label: ′<span style="font:500 11px var(--font-sans);padding:0 2px">${label}</span>′, className: '' });` |
| 94 | `const tabs: { id: Mode; label: string; icon: typeof Eye }[] = [` |
| 95 | `{ id: 'visual', label: 'Visual', icon: Paintbrush },` |
| 96 | `{ id: 'code', label: 'MJML + Liquid', icon: Code2 },` |
| 97 | `{ id: 'preview', label: 'Preview', icon: Eye },` |
| 106 | `<option key={t.id} value={t.id}>` |
| 136 | `Subject` |
| 177 | `<option key={p.id} value={p.id}>` |
| 206 | `{preview.error ? (` |
| 207 | `<div className="p-4 font-mono text-[12px] text-bad">{preview.error}</div>` |
| 209 | `<iframe title="E-mail preview" className="h-[560px] w-full bg-white" srcDoc={preview.html} sandbox="" />` |


### apps/web/src/screens/Journeys.tsx

[Baseline source](../../../apps/web/src/screens/Journeys.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 3 | `Background,` |
| 5 | `Controls,` |
| 7 | `Handle,` |
| 8 | `MarkerType,` |
| 9 | `MiniMap,` |
| 13 | `Position,` |
| 14 | `ReactFlow,` |
| 15 | `ReactFlowProvider,` |
| 17 | `import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';` |
| 40 | `<PageHeader eyebrow="Orchestration" title="Journeys">` |
| 42 | `Draft one with the copilot` |
| 113 | `title={warning}` |
| 132 | `{warning && <AlertTriangle size={13} className="ml-auto shrink-0 text-warn" aria-label="Needs attention before publishing" />}` |
| 172 | `const [versionNo, setVersionNo] = useState(journey.versions[journey.versions.length - 1].number);` |
| 174 | `const [graph, setGraph] = useState<{ nodes: JourneyNode[]; edges: JourneyEdge[] }>({ nodes: version.nodes, edges: version.edges });` |
| 175 | `const [selected, setSelected] = useState<string \| null>(null);` |
| 177 | `const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});` |
| 178 | `const [showStats, setShowStats] = useState(true);` |
| 179 | `const [sim, setSim] = useState<{` |
| 180 | `path: { nodeId: string; label: string; clock: string; note: string }[];` |
| 184 | `const [simProfile, setSimProfile] = useState(profiles[2]?.id ?? '');` |
| 233 | `label: e.label,` |
| 281 | `label: kindMeta[kind].label,` |
| 298 | `const res = await exec<{ path: { nodeId: string; label: string; clock: string; note: string }[]; profile: string }>(` |
| 327 | `<Button variant="ghost" onClick={onBack} aria-label="Back to journeys">` |
| 346 | `<option key={v.number} value={v.number}>` |
| 363 | `aria-label="Profile to simulate"` |
| 366 | `<option key={p.id} value={p.id}>` |
| 394 | `title={′Add ${m.label} after the selected step′}` |
| 439 | `Close` |
| 455 | `Dry run: no messages are sent. Agents use the same simulation via journeys.simulate.` |
| 471 | `aria-label="Delete step"` |
| 482 | `onChange={(e) => updateNode(sel.id, { label: e.target.value })}` |
| 502 | `AI steps run asynchronously with a fallback path, schema-validated output and a decision log. Only attributes marked “AI` |
| 508 | `The send gateway checks the lawful basis for <code className="font-mono">{String(sel.config.purpose)}</code>, suppressions` |


### apps/web/src/screens/LiveSite.tsx

[Baseline source](../../../apps/web/src/screens/LiveSite.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 21 | `const heroCopy: Record<Decision['variant'], { title: string; text: string; cta: string }> = {` |
| 23 | `title: 'The autumn range is in',` |
| 28 | `title: 'Trail shoes, picked for you',` |
| 33 | `title: 'Shells for sideways rain',` |
| 38 | `title: 'Ready for a night out?',` |
| 48 | `const [onlyMine, setOnlyMine] = useState(true);` |
| 49 | `const [email, setEmail] = useState('');` |
| 50 | `const [firstName, setFirstName] = useState('');` |
| 51 | `const [filter, setFilter] = useState<Category \| 'all'>('all');` |
| 57 | `<PageHeader eyebrow="Ingest → session state → decide, in your browser" title="Live site demo">` |
| 130 | `aria-label={′View ${p.name}′}` |
| 143 | `View` |
| 150 | `Add` |
| 185 | `Sign up` |
| 200 | `Check out` |
| 208 | `Leave the site` |
| 221 | `We use analytics and personalisation to show gear that fits what you are looking for. Strictly necessary cookies are` |
| 230 | `Accept all` |
| 237 | `Strictly necessary only` |
| 247 | `<Card title="Decision: home_hero" action={<Pill tone="accent">{live.decision.latencyMs} ms</Pill>}>` |
| 268 | `title="Visitor"` |
| 304 | `<Card title="Pipeline">` |
| 320 | `title="Event stream"` |


### apps/web/src/screens/Overview.tsx

[Baseline source](../../../apps/web/src/screens/Overview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 11 | `title: 'Browse the demo shop',` |
| 17 | `title: 'Ask the copilot',` |
| 23 | `title: 'Review the agent’s change',` |
| 29 | `title: 'Simulate a customer',` |
| 50 | `<PageHeader eyebrow="Overview · last 30 days" title={′${greeting()}, ${DEMO_PERSONA.name}′} />` |
| 53 | `<Kpi label="Messages sent" value={sum('sent').toLocaleString('en')} delta={4.2} />` |
| 54 | `<Kpi label="Click rate" value={′${((sum('clicks') / sum('sent')) * 100).toFixed(1)}%′} delta={-0.4} />` |
| 55 | `<Kpi label="Attributed orders" value={sum('conversions').toLocaleString('en')} delta={7.9} />` |
| 56 | `<Kpi label="Revenue influenced" value={dkk(sum('revenue'))} delta={11.3} />` |
| 57 | `<Kpi label="Events / min" value={lastMinute.length.toString()} hint="live, ingest p95 14 ms" />` |
| 61 | `<Card title="Try the demo" className="lg:row-span-2">` |
| 119 | `title="Journeys"` |
| 122 | `All journeys` |
| 144 | `<Card title="Waiting for you" action={<Pill tone={pending.length ? 'agent' : 'good'}>{pending.length} pending</Pill>}>` |


### apps/web/src/screens/Profiles.tsx

[Baseline source](../../../apps/web/src/screens/Profiles.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 11 | `const [q, setQ] = useState('');` |
| 18 | `<PageHeader eyebrow="Customer data" title="Profiles">` |
| 96 | `const [explain, setExplain] = useState<Record<string, string> \| null>(null);` |
| 97 | `const [exported, setExported] = useState<string \| null>(null);` |
| 98 | `const [confirmErase, setConfirmErase] = useState(false);` |
| 115 | `<PageHeader eyebrow={′${p.id} · ${p.city}, ${p.country}′} title={p.name}>` |
| 125 | `Confirm erasure` |
| 128 | `Cancel` |
| 151 | `title="Data subject access export (JSON)"` |
| 155 | `Close` |
| 164 | `<Card title="Traits">` |
| 192 | `<Card title="Consent & lawful basis" className="lg:col-span-2">` |
| 254 | `No events in this session yet. Ambient traffic will show up here.` |


### apps/web/src/screens/Setup.tsx

[Baseline source](../../../apps/web/src/screens/Setup.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 12 | `const [openTool, setOpenTool] = useState<string \| null>(null);` |
| 17 | `<PageHeader eyebrow="Workspace setup" title="Channels & MCP" />` |
| 20 | `<Card title="Channels & destinations">` |
| 64 | `<Card title="LLM providers (bring your own key)">` |
| 72 | `Used by AI journey steps and the copilot. Key stored encrypted, never returned by the API.` |
| 92 | `<Card title="MCP server" className="lg:col-span-2">` |
| 148 | `title="Audit log"` |


### apps/web/src/screens/nodeKinds.tsx

[Baseline source](../../../apps/web/src/screens/nodeKinds.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `Bell,` |
| 3 | `Braces,` |
| 4 | `Cable,` |
| 5 | `Clock,` |
| 6 | `Flag,` |
| 7 | `GitBranch,` |
| 8 | `Hourglass,` |
| 9 | `LogOut,` |
| 11 | `Mail,` |
| 12 | `MessageSquare,` |
| 13 | `Shuffle,` |
| 14 | `Sparkles,` |
| 15 | `UserCog,` |
| 16 | `Wand2,` |
| 17 | `Webhook,` |
| 18 | `Zap,` |
| 23 | `NodeKind,` |
| 24 | `{ label: string; icon: LucideIcon; group: 'Trigger' \| 'Flow' \| 'Action' \| 'AI'; ai?: boolean; defaults: JourneyNode['config'] }` |
| 26 | `trigger: { label: 'Trigger', icon: Zap, group: 'Trigger', defaults: { event: 'signed_up', reentry: 'once' } },` |
| 27 | `wait: { label: 'Wait', icon: Clock, group: 'Flow', defaults: { duration: 'P1D' } },` |
| 28 | `waitEvent: { label: 'Wait for event', icon: Hourglass, group: 'Flow', defaults: { event: 'email_clicked', timeout: 'P2D' } },` |
| 30 | `label: 'Wait until',` |
| 35 | `branch: { label: 'Branch', icon: GitBranch, group: 'Flow', defaults: { condition: 'trait.orders_count ≥ 1' } },` |
| 36 | `split: { label: 'A/B split', icon: Shuffle, group: 'Flow', defaults: { a: 50, b: 50, holdout: 10 } },` |
| 37 | `goal: { label: 'Goal', icon: Flag, group: 'Flow', defaults: { event: 'order_completed', within: 'P14D' } },` |
| 38 | `exit: { label: 'Exit', icon: LogOut, group: 'Flow', defaults: {} },` |
| 39 | `email: { label: 'Send e-mail', icon: Mail, group: 'Action', defaults: { template: 'tpl_welcome', purpose: 'marketing_email' } },` |
| 40 | `sms: { label: 'Send SMS', icon: MessageSquare, group: 'Action', defaults: { template: 'sms_reminder' } },` |
| 41 | `push: { label: 'Send push', icon: Bell, group: 'Action', defaults: { template: 'psh_sale' } },` |
| 42 | `webhook: { label: 'Webhook', icon: Webhook, group: 'Action', defaults: { url: 'https://hooks.example.com/crm', method: 'POST' } },` |
| 43 | `action: { label: 'Connector action', icon: Cable, group: 'Action', defaults: { connection: 'con_slack', action: 'postMessage' } },` |
| 45 | `label: 'Transform',` |
| 50 | `updateProfile: { label: 'Update profile', icon: UserCog, group: 'Action', defaults: { trait: 'lifecycle_stage', value: 'engaged' } },` |
| 52 | `label: 'AI decide',` |
| 59 | `label: 'AI generate',` |


### apps/web/src/mock/seed.ts

[Baseline source](../../../apps/web/src/mock/seed.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 115 | `label: string,` |
| 208 | `const welcomeV4Nodes = welcomeNodes.map((x) => (x.id === 'w1' ? { ...x, label: 'Wait 1 day', config: { duration: 'P1D' } } : x));` |
| 421 | `{ path: 'nodes.w1.config.duration', kind: 'changed', before: 'P2D', after: 'P1D' },` |


### apps/web/src/mock/store.ts

[Baseline source](../../../apps/web/src/mock/store.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 3 | `ApprovalPolicy,` |
| 4 | `ApprovalRequest,` |
| 5 | `AuditEntry,` |
| 6 | `EmailTemplate,` |
| 7 | `Experience,` |
| 8 | `Journey,` |
| 9 | `Profile,` |
| 10 | `Segment,` |
| 11 | `TrackedEvent,` |


### apps/server/test/e2e/seed.ts

[Baseline source](../../../apps/server/test/e2e/seed.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 25 | `const mjml = (title: string, body: string) => ′<mjml>` |
| 300 | `title: string;` |
| 317 | `title: 'Signal #33',` |
| 329 | `title: 'Signal #34',` |
| 341 | `title: 'Signal #35',` |
| 353 | `title: 'Signal #36',` |
| 365 | `title: 'Signal #37',` |
| 377 | `title: 'Signal #38',` |
| 389 | `title: 'Signal #39',` |
| 401 | `title: 'Signal #40',` |
| 417 | `const issueMjml = (title: string, body: string, href: string, cta: string) => ′<mjml>` |
| 459 | `await owner.call('workspace.setSeedList', { seedList: ['inbox-check@example.com'] }).catch(() => {});` |
| 460 | `await owner.call('emailProviders.create', {` |
| 467 | `await owner.call('secrets.set', { name: 'turnstile.secret_key', value: 'dev-secret-not-real' });` |
| 469 | `const logo = await owner.call('assets.upload', {` |
| 475 | `await owner.call('assets.upload', {` |
| 482 | `const pub = async (id: string, note: string) => owner.call('artifacts.requestPublish', { artifactId: id, note });` |
| 483 | `const brand = await owner.call('artifacts.create', {` |
| 495 | `title: 'The MartechSignal archive',` |
| 505 | `const purposes = await owner.call('artifacts.create', {` |
| 514 | `{ key: 'newsletter', name: 'Weekly newsletter', description: 'The Friday issue', default: 'subscribed' as const },` |
| 515 | `{ key: 'product_news', name: 'Product news', description: 'Launches and changes', default: 'unsubscribed' as const },` |
| 524 | `const confirm = await owner.call('artifacts.create', {` |
| 536 | `const issue42 = await owner.call('artifacts.create', {` |
| 548 | `const subscribers = await owner.call('artifacts.create', {` |
| 554 | `const engaged = await owner.call('artifacts.create', {` |
| 563 | `const form = await owner.call('artifacts.create', {` |
| 579 | `const footerForm = await owner.call('artifacts.create', {` |
| 597 | `await owner.call('profiles.import', { label: 'Kit export 2026-10-20', rows: people });` |
| 617 | `() => owner.call('segments.refresh', { artifactId: subscribers.artifactId }),` |
| 624 | `const archivedBroadcast = await owner.call('artifacts.create', {` |
| 635 | `const archivedVersion = await owner.call('artifacts.get', { artifactId: archivedBroadcast.artifactId });` |
| 643 | `const archivedIssue = (await owner.call('archive.issues', {})).issues.find((i) => i.artifactId === archivedBroadcast.artifactId);` |
| 647 | `const token = await builder.call('apiTokens.create', {` |
| 652 | `await builder.call('apiTokens.create', { name: 'n8n reporting', scopes: ['artifacts:read'] });` |
| 656 | `await agent.call('workspace.proposeUpdate', {` |
| 660 | `const ask = (id: string, note: string) => agent.call('artifacts.requestPublish', { artifactId: id, note });` |
| 662 | `const issue43 = await agent.call('artifacts.create', {` |
| 678 | `const bc = await agent.call('artifacts.create', {` |
| 691 | `const issue44 = await agent.call('artifacts.create', {` |
| 700 | `const send44 = await agent.call('artifacts.create', {` |
| 705 | `await agent.call('artifacts.requestPublishBundle', {` |
| 710 | `await agent.call('artifacts.updateDraft', {` |
| 744 | `const welcome = await agent.call('artifacts.create', {` |
| 754 | `label: 'Confirmed subscription',` |
| 758 | `{ id: 'n2', kind: 'email', label: 'Welcome e-mail', config: { template: issue42.artifactId }, next: [{ to: 'n3' }] },` |
| 759 | `{ id: 'n3', kind: 'wait', label: 'Wait two days', config: { duration: 'P2D' }, next: [{ to: 'n4' }] },` |
| 763 | `label: 'Opened the welcome?',` |
| 767 | `{ id: 'n5', kind: 'exit', label: 'Done', config: {} },` |
| 768 | `{ id: 'n6', kind: 'email', label: 'Best of MartechSignal', config: { template: issue42.artifactId }, next: [{ to: 'n7' }] },` |
| 769 | `{ id: 'n7', kind: 'exit', label: 'Exit', config: {} },` |
| 773 | `await agent.call('artifacts.requestPublish', {` |
| 778 | `await agent.call('artifacts.create', {` |
| 792 | `const hermesId = (await agent.call('agents.get', {})).id;` |
| 853 | `idempotency_key: ′bct:${opts.broadcastId}:${profileId}′,` |
| 911 | `await owner.call('consent.record', {` |
| 943 | `const template = await owner.call('artifacts.create', {` |
| 956 | `const broadcast = await owner.call('artifacts.create', {` |
| 1002 | `if (issue.agent) await owner.call('artifacts.setOwner', { artifactId: broadcast.artifactId, ownerAgentId: hermesId });` |
| 1006 | `const stoppedTemplate = await owner.call('artifacts.create', {` |
| 1021 | `const stoppedBroadcast = await owner.call('artifacts.create', {` |
| 1041 | `ON CONFLICT (workspace_id, broadcast_id) DO UPDATE SET status = 'stopped', error = excluded.error′,` |
| 1098 | `const scheduledTemplate = await owner.call('artifacts.create', {` |
| 1113 | `const scheduledBroadcast = await owner.call('artifacts.create', {` |
| 1127 | `const meta = await owner.call('connections.create', {` |
| 1133 | `const conversionMap = await owner.call('artifacts.create', {` |
| 1142 | `const campaign = await owner.call('artifacts.create', {` |
| 1196 | `const journeyTemplate = await owner.call('artifacts.create', {` |
| 1211 | `const onboarding = await owner.call('artifacts.create', {` |
| 1225 | `{ id: 'n2', kind: 'email', label: 'Welcome e-mail', config: { template: journeyTemplate.artifactId }, next: [{ to: 'n3' }] },` |
| 1234 | `{ id: 'n5', kind: 'goal', label: 'Opened two issues', config: { event: 'Email Opened', within: 'P14D' }, next: [{ to: 'n7' }] },` |
| 1235 | `{ id: 'n6', kind: 'email', label: 'Best of MartechSignal', config: { template: journeyTemplate.artifactId }, next: [{ to: 'n7' }] },` |
| 1236 | `{ id: 'n7', kind: 'exit', label: 'Done', config: {} },` |
| 1237 | `{ id: 'n8', kind: 'exit', label: 'Left the series', config: {} },` |
| 1259 | `entry_key: ′${onboarding.artifactId}:${profileId}′,` |
| 1278 | `x.matched, x.converted, x.context, x.error, x.entered_at, x.updated_at` |
| 1322 | `if (failed) addJourneyEvent(profileId, 'failed', 'n6', 4, addDays(enteredAt, 2.5), row.error ?? 'step failed');` |
| 1327 | `const experience = await owner.call('artifacts.create', {` |
| 1401 | `const hosted = await owner.call('agents.createHosted', {` |
| 1413 | `await owner.call('workspace.setAutonomy', {` |
| 1414 | `maxLevel: { draft: 3, 'content.publish': 3, 'send.broadcast': 3, 'send.direct': 2, 'journey.live': 2 },` |
| 1416 | `const mandate = await owner.call('artifacts.create', {` |
| 1429 | `levels: { draft: 3, 'content.publish': 3, 'send.broadcast': 3 },` |
| 1435 | `await owner.call('artifacts.requestPublish', { artifactId: mandate.artifactId, note: 'The weekly newsletter mandate' });` |
| 1486 | `actionClass: 'content.publish',` |
| 1657 | `PEOPLE.owner.name,` |
| 1663 | `const personLearning = await owner.call('learnings.add', {` |
| 1675 | `const agentLearning = await agent.call('learnings.add', {` |
| 1713 | `const bounceAlert = await owner.call('alerts.create', {` |
| 1719 | `const complaintAlert = await owner.call('alerts.create', {` |
| 1725 | `const journeyAlert = await owner.call('alerts.create', {` |
| 1771 | `const vipSegment = await owner.call('artifacts.create', {` |
| 1778 | `const vipImport = await owner.call('audiences.import', {` |


## I · shared host


### apps/web/src/features/artifacts/ArtifactListPage.tsx

[Baseline source](../../../apps/web/src/features/artifacts/ArtifactListPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { type ReactNode, useEffect, useMemo, useState } from 'react';` |
| 11 | `Alert,` |
| 12 | `Button,` |
| 13 | `EmptyState,` |
| 14 | `Field,` |
| 15 | `Input,` |
| 16 | `Modal,` |
| 17 | `PageHeader,` |
| 18 | `Select,` |
| 19 | `Table,` |
| 20 | `TableFrame,` |
| 21 | `Td,` |
| 22 | `THead,` |
| 23 | `Th,` |
| 24 | `Tr,` |
| 37 | `label: string;` |
| 52 | `* filter, then the table with loading, error and empty states.` |
| 60 | `emptyTitle,` |
| 61 | `emptyText,` |
| 67 | `title: string;` |
| 71 | `emptyTitle: string;` |
| 72 | `emptyText: ReactNode;` |
| 80 | `useCrumbs([{ label: crumb ?? title }]);` |
| 83 | `const [q, setQ] = useState('');` |
| 84 | `const [state, setState] = useState('');` |
| 85 | `const [creating, setCreating] = useState(false);` |
| 97 | `const canCreate = !!create && can('artifacts:write');` |
| 113 | `title={title}` |
| 124 | `loading={list.loading}` |
| 125 | `error={list.error}` |
| 135 | `aria-label={′Search ${title.toLowerCase()}′}` |
| 142 | `<Select compact aria-label="Publication state" value={state} onChange={(e) => setState(e.target.value)} className="w-auto">` |
| 143 | `<option value="">All publications</option>` |
| 144 | `<option value="live">Published</option>` |
| 145 | `<option value="draft">Draft</option>` |
| 146 | `<option value="in_review">In review</option>` |
| 147 | `<option value="rejected">Rejected</option>` |
| 162 | `title={emptyTitle}` |
| 171 | `{emptyText}` |
| 174 | `<EmptyState compact title="Nothing matches">` |
| 175 | `Clear the search or choose another state.` |
| 180 | `<Table label={title}>` |
| 183 | `<Th>Name</Th>` |
| 185 | `<Th key={c.header} className={c.className}>` |
| 189 | `<Th>Operational state</Th>` |
| 190 | `<Th>Updated</Th>` |
| 236 | `const [name, setName] = useState(spec.defaultName ?? '');` |
| 237 | `const [nameError, setNameError] = useState<string \| null>(null);` |
| 238 | `const [state, setState] = useState<S>(spec.initial ?? ({} as S));` |
| 239 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 240 | `const [busy, setBusy] = useState(false);` |
| 241 | `const [error, setError] = useState<string \| null>(null);` |
| 252 | `: await api.call('artifacts.create', { type: type as never, name: name.trim(), content: spec.content(name.trim(), state) });` |
| 267 | `title={spec.label}` |
| 271 | `<Button variant="primary" loading={busy} onClick={submit}>` |
| 272 | `Create draft` |
| 284 | `<Field label="Name" error={nameError} hint="Shown to reviewers and agents." required>` |


### apps/web/src/features/artifacts/ArtifactDetailPage.tsx

[Baseline source](../../../apps/web/src/features/artifacts/ArtifactDetailPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';` |
| 12 | `Alert,` |
| 13 | `Button,` |
| 14 | `Field,` |
| 16 | `Input,` |
| 17 | `LoadingBlock,` |
| 18 | `Menu,` |
| 19 | `Modal,` |
| 20 | `PageHeader,` |
| 21 | `Tabs,` |
| 22 | `Textarea,` |
| 61 | `readOnly: boolean;` |
| 62 | `/** Field errors from the last save, keyed by dotted path (e.g. "nodes.2.config.template"). */` |
| 70 | `loading: boolean;` |
| 96 | `/** The pending-approval read's loading/error state and retry; a slot must not act on a failed read. */` |
| 100 | `openTab: (key: string) => void;` |
| 158 | `/** Breadcrumbs before the artifact's name, e.g. [{label:'Journeys', to:'/marketing/journeys'}]. */` |
| 169 | `extraTabs?: { key: string; label: string; render: (a: Artifact) => ReactNode }[];` |
| 180 | `const canRead = can('artifacts:read');` |
| 182 | `const art = useApi(() => api.call('artifacts.get', { artifactId: id }), [id], { skip: restricted });` |
| 183 | `const pendingReq = useApi(() => api.call('approvals.list', { status: 'pending', artifactId: id, limit: 5 }), [id], {` |
| 184 | `skip: restricted,` |
| 187 | `useCrumbs([...crumbs, { label: a?.name ?? '…' }]);` |
| 189 | `const [innerTab, setInnerTab] = useState<Tab>('content');` |
| 192 | `(key: string) => {` |
| 198 | `const [draft, setDraft] = useState<unknown>(undefined);` |
| 199 | `const [editorReset, setEditorReset] = useState(0);` |
| 200 | `const [errors, setErrors] = useState<Record<string, string>>({});` |
| 201 | `const [saveError, setSaveError] = useState<string \| null>(null);` |
| 202 | `const [warnings, setWarnings] = useState<DraftWarning[]>([]);` |
| 203 | `const [saving, setSaving] = useState(false);` |
| 204 | `const [publishing, setPublishing] = useState(false);` |
| 205 | `const [renaming, setRenaming] = useState(false);` |
| 206 | `const [discardOpen, setDiscardOpen] = useState(false);` |
| 207 | `const [discardError, setDiscardError] = useState<string \| null>(null);` |
| 208 | `const [discarding, setDiscarding] = useState(false);` |
| 209 | `const [lastSave, setLastSave] = useState<'content' \| 'layout' \| null>(null);` |
| 210 | `const [savedAt, setSavedAt] = useState<number \| null>(null);` |
| 211 | `const [conflict, setConflict] = useState(false);` |
| 275 | `const readOnly = !can('artifacts:write');` |
| 302 | `const r = await api.call('artifacts.updateDraft', {` |
| 334 | `e instanceof ApiError && e.status === 412 ? ′${e.message} Your changes are still here; copy them before reloading.′ : errText(e),` |
| 355 | `readOnly,` |
| 365 | `}, [autosave, dirty, readOnly, saving, conflict, draft]);` |
| 370 | `if (e.key === 's' && (e.metaKey \|\| e.ctrlKey) && dirty && !readOnly) {` |
| 377 | `}, [dirty, readOnly, save]);` |
| 382 | `title={detail?.kind ?? 'Artifact'}` |
| 390 | `notice={{ title: detail?.restrictedTitle ?? 'Restricted access', body: detail?.restrictedBody }}` |
| 391 | `loadingContent={null}` |
| 395 | `if (art.loading) {` |
| 399 | `title=""` |
| 406 | `state="loading"` |
| 407 | `loadingContent={<LoadingBlock lines={8} />}` |
| 411 | `if (art.error \|\| !a) {` |
| 414 | `<Alert tone="bad" title="Couldn't open this item" onRetry={art.reload}>` |
| 415 | `{art.error}` |
| 418 | `const missing = !!art.error && /does not exist\|not found/i.test(art.error);` |
| 421 | `title={detail.kind ?? 'Artifact'}` |
| 430 | `title: missing ? (detail.notFoundTitle ?? 'Not found') : (detail.errorTitle ?? 'Couldn’t open this item'),` |
| 431 | `body: missing ? 'It may have been deleted or belongs to another workspace.' : (art.error ?? 'The server returned no artifact.'),` |
| 452 | `loading: pendingReq.loading,` |
| 453 | `error: pendingReq.error,` |
| 458 | `const canPublish = can('artifacts:publish') && latest.state === 'draft' && !dirty;` |
| 464 | `const r = await api.call('artifacts.discardDraft', { artifactId: a.id });` |
| 494 | `const autosaveStatus = autosave && !readOnly && (` |
| 511 | `label="More actions"` |
| 513 | `...(readOnly ? [] : [{ label: 'Rename', icon: <Pencil />, onSelect: () => setRenaming(true) }]),` |
| 514 | `...(a.publishedVersion && a.latestVersion > a.publishedVersion && !readOnly` |
| 517 | `label: ′Discard draft (back to live v${a.publishedVersion})′,` |
| 527 | `{ label: 'Copy id', icon: <Copy />, hint: a.id.slice(0, 8), onSelect: () => void navigator.clipboard?.writeText(a.id) },` |
| 533 | `aria-label="More actions"` |
| 545 | `<Alert tone="bad" title="Not saved" className="mb-4">` |
| 550 | `<Alert tone="warn" title="Fill these in before publishing" className="mb-4">` |
| 561 | `{ key: 'content', label: dirty ? 'Content •' : 'Content' },` |
| 562 | `...(preview ? [{ key: 'preview', label: 'Preview' }] : []),` |
| 563 | `...extraTabs.map((t) => ({ key: t.key, label: t.label })),` |
| 564 | `...(!editor && pageEditor ? [{ key: 'json', label: 'JSON' }] : []),` |
| 565 | `{ key: 'versions', label: 'Versions', count: a.latestVersion },` |
| 566 | `{ key: 'activity', label: 'Activity' },` |
| 568 | `const renderTab = (key: string) => {` |
| 575 | `pageEditor({ artifact: a, content: draft, onChange: updateDraft, readOnly, errors, warnings })` |
| 578 | `<JsonEditor value={draft} onChange={updateDraft} readOnly={readOnly} documentKey={a.id} />` |
| 590 | `readOnly={readOnly}` |
| 592 | `label="Content (JSON)"` |
| 593 | `hint="The same content the editor changes, and what agents read and write. Call artifacts.types for the schema."` |
| 600 | `// A dirty draft is labelled Unsaved draft and rendered from the local content. A broadcast` |
| 665 | `title={′Discard the draft and go back to live v${a.publishedVersion}?′}` |
| 669 | `Keep the draft` |
| 671 | `<Button variant="danger" loading={discarding} onClick={() => void discardDraft()}>` |
| 672 | `Discard draft` |
| 700 | `canApprove: can('artifacts:approve'),` |
| 713 | `title={a.name}` |
| 740 | `{dirty && !readOnly && (!autosave \|\| conflict) && (` |
| 743 | `Discard changes` |
| 745 | `<Button variant="primary" loading={saving} onClick={() => void save()}>` |
| 746 | `Save draft` |
| 751 | `<ButtonLink to={′/approvals/${pending.id}′} variant={can('artifacts:approve') ? 'primary' : 'secondary'}>` |
| 752 | `{can('artifacts:approve') ? 'Review the request' : 'View the approval request'}` |
| 771 | `key: item.key,` |
| 772 | `label: item.label,` |
| 831 | `<Tabs label="Sections" value={activeTab} onChange={changeTab} items={tabItems}>` |
| 840 | `const r = useApi(() => api.call('approvals.list', { status: 'rejected', artifactId: id, limit: 1 }), [id]);` |
| 844 | `<Alert tone="bad" title="Rejected" className="mb-4">` |
| 862 | `const [note, setNote] = useState('');` |
| 863 | `const [error, setError] = useState<string \| null>(null);` |
| 864 | `const [noteError, setNoteError] = useState<string \| null>(null);` |
| 865 | `const [busy, setBusy] = useState(false);` |
| 871 | `const r = await api.call('artifacts.requestPublish', { artifactId: artifact.id, note: note.trim() });` |
| 886 | `title={direct ? ′Publish “${artifact.name}”?′ : ′Submit “${artifact.name}” for review?′}` |
| 890 | `<Button variant="primary" loading={busy} onClick={submit}>` |
| 903 | `<Field label="What changed?" hint="Shown to the reviewer and kept in the version history." error={noteError} required>` |
| 925 | `const [value, setValue] = useState(name);` |
| 932 | `title="Rename"` |
| 939 | `loading={busy}` |
| 946 | `Rename` |
| 951 | `<Field label="Name" hint="Renaming saves the current content as a draft too.">` |


### apps/web/src/features/artifacts/ArtifactSelect.tsx

[Baseline source](../../../apps/web/src/features/artifacts/ArtifactSelect.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 26 | `<Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled \|\| list.loading}>` |
| 27 | `<option value="">{list.loading ? 'Loading…' : list.error ? ′Couldn't load: ${list.error}′ : placeholder}</option>` |
| 28 | `{!known && <option value={value}>{value} (not found)</option>}` |
| 30 | `<option key={a.id} value={a.id}>` |


### apps/web/src/features/artifacts/VersionsPanel.tsx

[Baseline source](../../../apps/web/src/features/artifacts/VersionsPanel.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { useState } from 'react';` |
| 5 | `Actor,` |
| 6 | `Alert,` |
| 7 | `DiffView,` |
| 9 | `JsonView,` |
| 10 | `LoadingBlock,` |
| 11 | `StatePill,` |
| 12 | `Table,` |
| 13 | `TableFrame,` |
| 14 | `Tabs,` |
| 15 | `Td,` |
| 16 | `THead,` |
| 17 | `Th,` |
| 18 | `Tr,` |
| 26 | `() => api.call('artifacts.history', { artifactId: artifact.id }),` |
| 29 | `const [open, setOpen] = useState<number \| null>(null);` |
| 33 | `<TableFrame loading={h.loading} error={h.error} onRetry={h.reload} isEmpty={!versions.length} columns={4}>` |
| 34 | `<Table label="Versions">` |
| 37 | `<Th>Version</Th>` |
| 38 | `<Th>State</Th>` |
| 39 | `<Th>By</Th>` |
| 40 | `<Th>When</Th>` |
| 64 | `<Td className="whitespace-nowrap" title={formatDateTime(v.createdAt, { zone: true })}>` |
| 77 | `Select a version to see what changed in it.` |
| 86 | `const [view, setView] = useState<'diff' \| 'content'>('diff');` |
| 88 | `() => api.call('artifacts.diff', { artifactId, from: number > 1 ? number - 1 : undefined, to: number }),` |
| 91 | `const content = useApi(() => api.call('artifacts.get', { artifactId, version: number }), [artifactId, number], {` |
| 92 | `skip: view !== 'content',` |
| 96 | `label={′Version ${number}′}` |
| 100 | `{ key: 'diff', label: number > 1 ? ′Changes from v${number - 1}′ : 'First version' },` |
| 101 | `{ key: 'content', label: 'Content' },` |
| 105 | `(diff.loading ? (` |
| 107 | `) : diff.error ? (` |
| 108 | `<Alert tone="bad">{diff.error}</Alert>` |
| 113 | `(content.loading ? (` |
| 115 | `) : content.error ? (` |
| 116 | `<Alert tone="bad">{content.error}</Alert>` |
| 118 | `<JsonView value={content.data?.version.content} maxHeight={560} />` |


### apps/web/src/features/artifacts/ActivityPanel.tsx

[Baseline source](../../../apps/web/src/features/artifacts/ActivityPanel.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 26 | `(['pending', 'approved', 'rejected'] as const).map((status) => api.call('approvals.list', { status, artifactId, limit: 50 })),` |
| 33 | `const audit = useApi(() => api.call('audit.list', { target: artifactId, limit: 100 }), [artifactId], { skip: !can('audit:read') });` |
| 36 | `<Card title="Reviews">` |
| 37 | `{approvals.loading ? (` |
| 40 | `<EmptyState compact title="No reviews yet">` |
| 41 | `Requests to publish and their decisions show here.` |
| 62 | `Open` |
| 69 | `{can('audit:read') ? (` |
| 70 | `<Card title="Audit log" description="Every command run on this item, by people and agents, from the tamper-evident log.">` |
| 72 | `loading={audit.loading}` |
| 73 | `error={audit.error}` |
| 76 | `empty={<EmptyState compact title="No entries" />}` |
| 79 | `<Table label="Audit log">` |
| 82 | `<Th>When</Th>` |
| 83 | `<Th>Who</Th>` |
| 84 | `<Th>What</Th>` |
| 85 | `<Th>Via</Th>` |
| 86 | `<Th>Result</Th>` |
| 96 | `<Td>{e.ok ? <StatusPill tone="good">OK</StatusPill> : <StatusPill tone="bad">{e.error ?? 'Failed'}</StatusPill>}</Td>` |


### apps/web/src/features/previews/ArtifactPreview.tsx

[Baseline source](../../../apps/web/src/features/previews/ArtifactPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 127 | `<JsonView value={content} label="Content" maxHeight={compact ? 480 : 720} />` |
| 142 | `* the loading fallback reports loading, this boundary reports error, and only the mounted graph` |
| 157 | `<Alert tone="bad" title="Couldn’t render this journey graph">` |
| 158 | `The journey could not be drawn, so this review cannot be marked viewed. The reviewed steps are still shown in the Content tab.` |
| 181 | `const names = useArtifactNames(referencedIds(content.nodes));` |
| 186 | `Purpose <strong className="font-medium">{content.purpose}</strong>` |
| 187 | `{content.goal ? <> · Goal: {content.goal}</> : null}` |
| 193 | `<ReportPreviewStatus id={reportId} status="loading" />` |
| 194 | `<LoadingBlock lines={6} label="Loading the journey graph" />` |
| 199 | `<JourneyGraph nodes={content.nodes ?? []} names={names} height={height} />` |


### apps/web/src/features/previews/BlockPreview.tsx

[Baseline source](../../../apps/web/src/features/previews/BlockPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 29 | `const [width, setWidth] = useState<'desktop' \| 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));` |
| 36 | `const { data, error, loading, refresh } = useSharedRead(` |
| 39 | `() => api.call('blocks.preview', { artifactId, version: pinned }),` |
| 40 | `{ skip: unsaved },` |
| 49 | `const status: PreviewStatus = unsaved ? 'ready' : loading ? 'loading' : error ? 'error' : data ? 'ready' : 'loading';` |
| 55 | `<Alert tone="warn" title="Save draft to render this block">` |
| 56 | `A block preview renders a saved version with its default parameters. Nothing saved is shown under an unsaved label.` |
| 60 | `if (loading) return <LoadingBlock lines={6} label="Rendering the block" />;` |
| 63 | `<Alert tone="bad" title="Couldn't render this block" onRetry={refresh}>` |
| 72 | `<Alert tone="warn" title="Rendering warnings">` |
| 82 | `label="Preview width"` |
| 86 | `{ key: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },` |
| 87 | `{ key: 'mobile', label: 'Mobile', icon: <Smartphone size={13} aria-hidden /> },` |
| 93 | `title={′Block preview, ${width}′}` |


### apps/web/src/features/previews/BroadcastPreview.tsx

[Baseline source](../../../apps/web/src/features/previews/BroadcastPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 58 | `const skip = !can('artifacts:read') \|\| eligibility === 'save-required';` |
| 62 | `() => api.call('broadcasts.preview', { artifactId, version, templateVersion }),` |
| 65 | `const tpl = useArtifactRef(content.template);` |
| 66 | `const isEmail = content.template?.startsWith('eml_');` |
| 72 | `const guardLoading = !!blockGuard?.loading;` |
| 73 | `const guardFailed = !!blockGuard && (!!blockGuard.error \|\| blockGuard.unavailable);` |
| 77 | `: reach.loading` |
| 78 | `? 'loading'` |
| 79 | `: reach.error` |
| 81 | `: isEmail && content.template` |
| 86 | `: tpl.error` |
| 90 | `: 'loading'` |
| 96 | `{content.description && <p className="text-[13px] text-fg-2">{content.description}</p>}` |
| 98 | `<Stat label="Would receive it now">` |
| 101 | `) : reach.loading ? (` |
| 103 | `) : reach.error ? (` |
| 104 | `<span className="text-[13px] text-bad">{reach.error}</span>` |
| 109 | `<Stat label="In the segment">` |
| 118 | `<Stat label="Sends">` |
| 120 | `{content.sendAt ? formatDateTime(content.sendAt, { zone: true }) : 'As soon as it is approved'}` |
| 125 | `<Alert tone="info" title="Skipped at send time">` |
| 138 | `{content.sendWindow && (` |
| 140 | `Sends between {content.sendWindow.start} and {content.sendWindow.end} in each reader’s time zone` |
| 141 | `{content.sendWindow.days?.length ? ′, on ${content.sendWindow.days.join(', ')}′ : ', every day'}. Anyone outside it waits for the` |
| 142 | `next opening; those whose next opening is more than {content.sendWindow.maxDelay ?? 'P1D'} after the send time are skipped.` |
| 145 | `{content.subjectTest && (` |
| 147 | `title="Subject test"` |
| 148 | `description={′${content.subjectTest.samplePercent}% of the audience gets one of ${content.subjectTest.subjects.length} subjects; after ${content.subjectTest.decideAfter} the winner by ${content.subjectTest.metric === 'click' ? 'clicks' : 'opens'} goes to the rest.′}` |
| 151 | `{content.subjectTest.subjects.map((subject, i) => (` |
| 165 | `['Template', <RefName key="template" id={content.template} />],` |
| 166 | `['Segment', <RefName key="segment" id={content.segment} />],` |
| 172 | `{isEmail && content.template && (` |
| 174 | `title="The e-mail"` |
| 186 | `<LoadingBlock lines={4} label="Resolving reusable blocks" />` |
| 190 | `tone={blockGuard?.error ? 'bad' : 'warn'}` |
| 191 | `title={` |
| 192 | `blockGuard?.error` |
| 196 | `{...(blockGuard?.error ? { onRetry: blockGuard.onRetry } : {})}` |
| 198 | `{blockGuard?.error` |
| 205 | `label={` |
| 214 | `<BundledBlocks pins={blockGuard.pins} loading={false} error={null} onRetry={blockGuard.onRetry} showHeading />` |
| 221 | `artifactId={content.template}` |
| 227 | `) : tpl.error ? (` |
| 228 | `<Alert tone="bad">{tpl.error}</Alert>` |
| 239 | `function Stat({ label, children }: { label: string; children: React.ReactNode }) {` |


### apps/web/src/features/previews/BundledBlocks.tsx

[Baseline source](../../../apps/web/src/features/previews/BundledBlocks.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 8 | `loading: boolean;` |
| 28 | `loading,` |
| 39 | `if (!pins.length && !loading && !error) return null;` |
| 45 | `Reusable blocks` |
| 48 | `Each block is shown at the exact version this review would use: the bundle override when there is one, otherwise its published` |
| 53 | `{loading && <LoadingBlock lines={4} label="Resolving reusable blocks" />}` |
| 54 | `{error && !loading && (` |
| 55 | `<Alert tone="bad" title="Some reusable blocks could not be read" onRetry={onRetry}>` |
| 61 | `<Alert key={pin.id} tone="bad" title={′Reusable block ${pin.id} is unavailable′}>` |
| 62 | `This block has no published version and is not in this bundle, so there is no exact version to render.` |


### apps/web/src/features/previews/ChecksPanel.tsx

[Baseline source](../../../apps/web/src/features/previews/ChecksPanel.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useState } from 'react';` |
| 44 | `const base = useSharedRead('templates.check', { artifactId, version }, () => api.call('templates.check', { artifactId, version }), {});` |
| 45 | `const [full, setFull] = useState<Checks \| null>(null);` |
| 46 | `const [checkingLinks, setCheckingLinks] = useState(false);` |
| 47 | `const [linkError, setLinkError] = useState<string \| null>(null);` |
| 55 | `setFull(await api.call('templates.check', { artifactId, version, checkLinks: true }));` |
| 63 | `if (base.error && !shown)` |
| 65 | `<Alert tone="bad" title="Couldn't check this e-mail" onRetry={base.refresh}>` |
| 66 | `{base.error}` |
| 71 | `<Card title="Checks" padded>` |
| 85 | `title="Checks"` |
| 97 | `loading={checkingLinks}` |
| 99 | `title="Fetch the links in this e-mail (up to 30, cached for an hour)"` |
| 101 | `Check links` |
| 109 | `<Alert tone="warn" title="Link checking failed">` |
| 115 | `<section key={g.severity} aria-label={severityLabel[g.severity]}>` |
| 126 | `<summary className="cursor-pointer text-[12px] font-semibold tracking-wide text-muted uppercase hover:text-fg-2">` |


### apps/web/src/features/previews/EmailPreview.tsx

[Baseline source](../../../apps/web/src/features/previews/EmailPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `import { useEffect, useRef, useState } from 'react';` |
| 42 | `const [state, setState] = useState<DraftEmailState>({ status: 'idle' });` |
| 43 | `const [attempt, setAttempt] = useState(0);` |
| 100 | `const [width, setWidth] = useState<'desktop' \| 'mobile'>(() => (window.innerWidth < 640 ? 'mobile' : 'desktop'));` |
| 101 | `const [tab, setTab] = useState<'html' \| 'text'>('html');` |
| 115 | `() => api.call('templates.preview', { artifactId, version: pinned }),` |
| 116 | `{ skip: !!unsaved },` |
| 130 | `() => api.call('templates.preview', { artifactId, version: baseVersion }),` |
| 131 | `{ skip: !blocked \|\| !baseVersion },` |
| 133 | `const rendering = unsaved ? local.state.status === 'rendering' \|\| local.state.status === 'idle' : server.loading;` |
| 134 | `const failure = unsaved ? (local.state.status === 'error' ? local.state.message : null) : server.error;` |
| 138 | `unsaved && !draftContent ? 'ready' : blocked ? 'ready' : rendering ? 'loading' : failure ? 'error' : shown ? 'ready' : 'loading';` |
| 145 | `<Alert tone="warn" title="Save draft to render this e-mail">` |
| 146 | `A local render needs the draft content. Nothing saved is shown under an unsaved label.` |
| 155 | `<Alert tone="warn" title="Save draft to render reusable blocks">` |
| 161 | `<summary className="cursor-pointer text-[12px] font-medium text-fg-2">Saved v{baseVersion} · previous saved preview</summary>` |
| 164 | `title="Previous saved e-mail preview"` |
| 176 | `if (rendering) return <LoadingBlock lines={6} label={unsaved ? 'Rendering draft…' : 'Rendering the e-mail'} />;` |
| 183 | `title={unsaved ? "Couldn't render this draft" : "Couldn't render this e-mail"}` |
| 210 | `None. Inboxes show the first line of the body instead.` |
| 218 | `<Alert tone="warn" title="Rendering warnings">` |
| 229 | `label="Version"` |
| 231 | `{ key: 'html', label: 'HTML' },` |
| 232 | `{ key: 'text', label: 'Text version' },` |
| 239 | `label="Preview width"` |
| 243 | `{ key: 'desktop', label: 'Desktop', icon: <Monitor size={13} aria-hidden /> },` |
| 244 | `{ key: 'mobile', label: 'Mobile', icon: <Smartphone size={13} aria-hidden /> },` |
| 252 | `title={′E-mail preview, ${width}′}` |
| 265 | `<Alert tone="info" title="Save draft to generate the text version">` |
| 266 | `The local renderer does not invent a text version from HTML. Add a plain-text part to preview it here, or save and use the` |
| 270 | `<CodeView value={shown.text \|\| '(empty)'} label="Plain-text part" maxHeight={compact ? 420 : 640} />` |


### apps/web/src/features/previews/FormPreview.tsx

[Baseline source](../../../apps/web/src/features/previews/FormPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 63 | `const traits = content.traits ?? ['firstName'];` |
| 68 | `<Card title="What visitors see" description="Fields and consent text; the site renders the form itself.">` |
| 83 | `{content.consentText \|\| <span className="text-bad">No consent text</span>}` |
| 89 | `<Card title="What happens">` |
| 96 | `{(content.purposes ?? []).map((p) => (` |
| 103 | `content.doubleOptIn === false ? 'Off: consent counts at once' : 'On: consent counts after the person confirms',` |
| 105 | `['Confirmation e-mail', <RefName key="confirmation" id={content.confirmationTemplate} />],` |
| 106 | `['After submit', url(content.successUrl)],` |
| 107 | `['After confirming', content.confirmedUrl ? url(content.confirmedUrl) : 'The branded confirmation page'],` |
| 108 | `['On error', url(content.errorUrl)],` |
| 109 | `['Allowed sites', content.allowedOrigins?.length ? content.allowedOrigins.join(', ') : 'Any site'],` |
| 110 | `['Bot check', content.turnstile ? 'Cloudflare Turnstile required' : 'None'],` |
| 111 | `['Hosted pages', content.hostedPages ? 'Overrides the workspace brand' : 'Workspace brand'],` |
| 117 | `{content.doubleOptIn !== false && !content.confirmationTemplate && (` |


### apps/web/src/features/previews/SegmentPreview.tsx

[Baseline source](../../../apps/web/src/features/previews/SegmentPreview.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 38 | `const skip = !can('profiles:read') \|\| unsaved;` |
| 42 | `() => api.call('segments.preview', { artifactId, version: pinned }),` |
| 45 | `const mode = content.mode ?? 'dynamic';` |
| 47 | `const status: PreviewStatus = skip ? 'ready' : size.loading ? 'loading' : size.error ? 'error' : 'ready';` |
| 52 | `{content.description && <p className="text-[13px] text-fg-2">{content.description}</p>}` |
| 59 | `) : !can('profiles:read') ? (` |
| 61 | `) : size.loading ? (` |
| 63 | `) : size.error ? (` |
| 64 | `<p className="text-[13px] text-bad">{size.error}</p>` |
| 72 | `<Card title="Who is in it">` |
| 75 | `content.condition ? (` |
| 76 | `<ConditionView condition={content.condition} />` |
| 83 | `? ′A frozen snapshot of ${content.sourceSegment ?? 'another segment'}${content.snapshotVersion ? ′ at v${content.snapshotVersion}′ : ''}. Its members stay fixed until it is refreshed.′` |


### apps/web/src/features/previews/previewRead.tsx

[Baseline source](../../../apps/web/src/features/previews/previewRead.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 1 | `import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';` |
| 12 | `loading: boolean;` |
| 22 | `const EMPTY: ReadSnapshot<never> = { data: undefined, error: null, loading: false, refreshing: false };` |
| 36 | `/** The cache key: the command plus its exact input, with object keys in a stable order. */` |
| 47 | `private entry(key: string): Entry {` |
| 51 | `snapshot: { data: undefined, error: null, loading: true, refreshing: false },` |
| 60 | `peek<T>(key: string): ReadSnapshot<T> {` |
| 64 | `subscribe(key: string, listener: () => void) {` |
| 73 | `const first = entry.snapshot.data === undefined && entry.snapshot.error === null;` |
| 76 | `loading: first,` |
| 85 | `entry.snapshot = { data, error: null, loading: false, refreshing: false };` |
| 88 | `entry.snapshot = { ...entry.snapshot, error: errText(error), loading: false, refreshing: false };` |
| 101 | `load<T>(key: string, fn: () => Promise<T>) {` |
| 103 | `if (entry.promise \|\| entry.snapshot.data !== undefined \|\| entry.snapshot.error !== null) return;` |
| 108 | `refresh<T>(key: string, fn: () => Promise<T>) {` |
| 124 | `const [cache] = useState(() => new PreviewReadCache());` |
| 141 | `const [fallback] = useState(() => new PreviewReadCache());` |


### apps/web/src/features/previews/previewStatus.tsx

[Baseline source](../../../apps/web/src/features/previews/previewStatus.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 4 | `// reports its own state; the Review panel aggregates them, so a loading or failed preview never` |
| 7 | `export type PreviewStatus = 'loading' \| 'ready' \| 'error';` |


### apps/web/src/app/nav.ts

[Baseline source](../../../apps/web/src/app/nav.ts) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 2 | `Bell,` |
| 3 | `Bot,` |
| 4 | `BriefcaseBusiness,` |
| 5 | `Building2,` |
| 6 | `Cable,` |
| 7 | `ChartNoAxesCombined,` |
| 8 | `CheckSquare,` |
| 9 | `ClipboardList,` |
| 10 | `Files,` |
| 11 | `HeartPulse,` |
| 12 | `House,` |
| 13 | `Image as ImageIcon,` |
| 14 | `KeyRound,` |
| 15 | `ListFilter,` |
| 17 | `Mail,` |
| 18 | `Mails,` |
| 19 | `Megaphone,` |
| 20 | `Palette,` |
| 21 | `PanelsTopLeft,` |
| 22 | `Plug,` |
| 23 | `Send,` |
| 24 | `Settings,` |
| 25 | `ShieldCheck,` |
| 26 | `Target,` |
| 27 | `Users,` |
| 28 | `UsersRound,` |
| 29 | `Workflow,` |
| 40 | `label: string;` |
| 46 | `key: string;` |
| 58 | `key: 'work',` |
| 59 | `label: 'Work',` |
| 62 | `{ path: '/', label: 'Home', icon: House, needs: ANYONE },` |
| 63 | `{ path: '/approvals', label: 'Approvals', icon: CheckSquare, needs: ['artifacts:read'] },` |
| 64 | `{ path: '/work/agents', label: 'Agents', icon: Bot, needs: ['artifacts:read'] },` |
| 68 | `key: 'marketing',` |
| 69 | `label: 'Marketing',` |
| 72 | `{ path: '/marketing/campaigns', label: 'Campaigns', icon: Target, needs: ['artifacts:read'] },` |
| 73 | `{ path: '/marketing/broadcasts', label: 'Broadcasts', icon: Send, needs: ['artifacts:read'] },` |
| 74 | `{ path: '/marketing/journeys', label: 'Journeys', icon: Workflow, needs: ['artifacts:read'] },` |
| 75 | `{ path: '/marketing/experiences', label: 'Web experiences', icon: PanelsTopLeft, needs: ['artifacts:read'] },` |
| 79 | `key: 'audience',` |
| 80 | `label: 'Audience',` |
| 83 | `{ path: '/audience/people', label: 'People', icon: Users, needs: ['profiles:read'] },` |
| 84 | `{ path: '/audience/segments', label: 'Segments', icon: ListFilter, needs: ['artifacts:read'] },` |
| 85 | `{ path: '/audience/forms', label: 'Forms', icon: ClipboardList, needs: ['artifacts:read'] },` |
| 87 | `{ path: '/audience/consent', label: 'Consent', icon: ShieldCheck, needs: ['profiles:read', 'artifacts:read'] },` |
| 91 | `key: 'content',` |
| 92 | `label: 'Content',` |
| 95 | `{ path: '/content/templates', label: 'Templates', icon: Mail, needs: ['artifacts:read'] },` |
| 96 | `{ path: '/content/assets', label: 'Assets', icon: ImageIcon, needs: ['artifacts:read'] },` |
| 97 | `{ path: '/content/brand', label: 'Brand', icon: Palette, needs: ['artifacts:read'] },` |
| 101 | `key: 'insights',` |
| 102 | `label: 'Insights',` |
| 105 | `{ path: '/insights/analytics', label: 'Analytics', icon: ChartNoAxesCombined, needs: ['artifacts:read'] },` |
| 106 | `{ path: '/insights/messages', label: 'Message activity', icon: Mails, needs: ['profiles:read'] },` |
| 107 | `{ path: '/insights/deliverability', label: 'Deliverability', icon: HeartPulse, needs: ['artifacts:read'] },` |
| 108 | `{ path: '/insights/alerts', label: 'Alerts', icon: Bell, needs: ['artifacts:read'] },` |
| 118 | `key: 'settings',` |
| 119 | `label: 'Settings',` |
| 123 | `{ path: '/settings/workspace', label: 'Workspace', icon: Building2, needs: ['workspace:admin'] },` |
| 124 | `{ path: '/settings/providers', label: 'Providers', icon: Plug, needs: ['workspace:admin'] },` |
| 125 | `{ path: '/settings/integrations', label: 'Integrations and API tokens', icon: Cable, needs: ANYONE },` |
| 126 | `{ path: '/settings/secrets', label: 'Secrets', icon: KeyRound, needs: ['secrets:read'] },` |
| 127 | `{ path: '/settings/users', label: 'Users and roles', icon: UsersRound, needs: ['workspace:admin'] },` |
| 130 | `label: 'Approval policy and agent autonomy',` |


### apps/web/src/ui/ListPage.tsx

[Baseline source](../../../apps/web/src/ui/ListPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 13 | `export type PageReadState = 'loading' \| 'ready' \| 'empty' \| 'error' \| 'restricted';` |
| 17 | `title: string;` |
| 34 | `/** Replaces the rows while loading; the caller supplies its row skeletons. */` |
| 35 | `loadingContent: ReactNode;` |
| 57 | `loadingContent,` |
| 65 | `<PageHeader title={title} description={description} actions={primaryAction} />` |
| 73 | `{state === 'loading' ? (` |
| 75 | `{loadingContent}` |
| 80 | `<Alert tone="warn" title={notice.title} action={notice.action} className="mb-3">` |
| 93 | `<Alert tone="bad" title={notice?.title ?? 'Couldn’t load this list'} action={notice?.action} className="m-3">` |
| 97 | `<EmptyState title={notice?.title ?? ''} action={notice?.action}>` |


### apps/web/src/ui/DetailPage.tsx

[Baseline source](../../../apps/web/src/ui/DetailPage.tsx) · Destination follows owner rule above.

| Line | Existing field/action/tab/state evidence |
|---|---|
| 15 | `key: string;` |
| 16 | `label: string;` |
| 21 | `title: string;` |
| 36 | `onTabChange: (key: string) => void;` |
| 41 | `/** Keeps the panel's space while the read is loading. */` |
| 42 | `loadingContent: ReactNode;` |
| 56 | `* A detail page on the v2 template. A loading read keeps the header and consequence space; an` |
| 73 | `loadingContent,` |
| 75 | `if (state === 'loading') {` |
| 80 | `{loadingContent}` |
| 111 | `<Alert tone="bad" title={notice?.title ?? 'Couldn’t open this item'} action={notice?.action} className="m-3">` |
| 115 | `<EmptyState title={notice?.title ?? ''} action={notice?.action}>` |
| 132 | `label="Sections"` |
| 135 | `items={tabs.map((tab) => ({ key: tab.key, label: tab.label }))}` |
| 141 | `<aside className="min-w-0 rounded-lg bg-surface-2 p-4 xl:p-5" aria-label="Context">` |
