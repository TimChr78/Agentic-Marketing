import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Guard against recurrence of the 0.14.6 stale-data class (#596, #611, #612, #617, #618, #619):
// a read whose identity is an entity id, a filter or a period must not use plain `useApi`, which
// deliberately keeps the previous result while the new one runs. It must use `useKeyedApi`, or be
// listed below with a reason why its screen already withholds the old value. A new call fails this
// test until it has been judged.

const ROOT = process.cwd().endsWith('apps/web') ? join(process.cwd(), '../..') : process.cwd();
const SRC = join(ROOT, 'apps/web/src');

/** Dependencies that identify a different read rather than refresh the same one. */
const ID_LIKE =
  /^(?:id|.*Id|.*_id|filterKey|cursor|param|days|kind|status|type|since|after|before|number|version|q|query|committedQ|appliedSelectors|dnsKey|refreshKey|key|resolvedId|workspaceId)$|\.(?:from|to)$/;

interface Site {
  /** Repo-relative path, as written in the allowlist. */
  file: string;
  command: string;
  deps: string;
  line: number;
  flagged: string[];
}

interface Kept {
  /** `<file> :: <command> :: <normalised deps>` */
  call: string;
  reason: string;
}

/**
 * Calls judged and deliberately kept. Each reason says why the previous result can never be shown
 * under a new selection (a refreshing gate, a parent that withholds and unmounts, a route-fixed
 * type, a tagged response, or an explicit refresh counter).
 */
const KEPT: Kept[] = [
  {
    call: 'apps/web/src/features/integrations/WebhooksCard.tsx :: deliveries.list :: [id, version]',
    reason:
      'One EndpointLastDelivery per endpoint row, rendered with key={e.id}, so id never changes for an instance; version is an explicit refresh of the same read.',
  },
  {
    call: 'apps/web/src/features/agents/HostedAgentCard.tsx :: agents.hostedRuns :: [agentId]',
    reason:
      'AgentPage withholds the previous agent and unmounts its tabs while the keyed agents.get loads; hosted paging also resets on view.data.',
  },
  {
    call: 'apps/web/src/features/agents/HostedAgentCard.tsx :: agents.memory.list :: [agentId]',
    reason:
      'AgentPage withholds the previous agent and unmounts its tabs while the keyed agents.get loads; hosted paging also resets on view.data.',
  },
  {
    call: 'apps/web/src/features/agents/phase26/ComparisonSection.tsx :: agents.compare :: [appliedKey, period.from, period.to, refreshKey]',
    reason:
      'The comparison replaces its table with its busy skeleton on refreshing, so a new period or agent set never shows the old totals.',
  },
  {
    call: 'apps/web/src/features/agents/phase26/MandateTab.tsx :: agents.mandate :: [agentId]',
    reason:
      'AgentPage withholds the previous agent and unmounts its tabs while the keyed agents.get loads, and the tab gates on refreshing.',
  },
  {
    call: 'apps/web/src/features/agents/phase26/OverviewTab.tsx :: agents.report :: [agentId, period.from, period.to, refreshKey]',
    reason: 'The report substitutes its KPI skeleton on refreshing, so a new agent or period never shows the previous report.',
  },
  {
    call: 'apps/web/src/features/agents/ShadowCard.tsx :: agents.shadowReport :: [agentId]',
    reason: 'AgentPage withholds the previous agent and unmounts its tabs while the keyed agents.get loads.',
  },
  {
    call: 'apps/web/src/features/artifacts/ActivityPanel.tsx :: approvals.list :: [artifactId]',
    reason: 'ArtifactDetailPage withholds the previous artifact and unmounts its tab while the keyed artifacts.get loads.',
  },
  {
    call: 'apps/web/src/features/artifacts/ActivityPanel.tsx :: audit.list :: [artifactId]',
    reason: 'ArtifactDetailPage withholds the previous artifact and unmounts its tab while the keyed artifacts.get loads.',
  },
  {
    call: 'apps/web/src/features/artifacts/ArtifactDetailPage.tsx :: approvals.list :: [id]',
    reason: 'Inside the page body, which unmounts while the keyed artifacts.get for the new id loads.',
  },
  {
    call: 'apps/web/src/features/artifacts/artifactList.ts :: fetchAllArtifacts :: [type]',
    reason: 'The type comes from the route; a different artifact type is a different page component, never an in-place change.',
  },
  {
    call: 'apps/web/src/features/artifacts/ArtifactListPage.tsx :: fetchAllArtifacts :: [type]',
    reason: 'The type comes from the route; a different artifact type is a different page component, never an in-place change.',
  },
  {
    call: 'apps/web/src/features/artifacts/CampaignMembership.tsx :: campaigns.of :: [artifactId]',
    reason: 'ArtifactDetailPage withholds the previous artifact and unmounts its tabs while the keyed artifact read loads.',
  },
  {
    call: 'apps/web/src/features/artifacts/ListAudiencePanel.tsx :: segments.members :: [artifactId, after]',
    reason: 'ArtifactDetailPage withholds the previous artifact; `after` is same-list paging, which intentionally keeps the current page.',
  },
  {
    call: 'apps/web/src/features/artifacts/ListAudiencePanel.tsx :: audiences.imports :: [artifactId]',
    reason: 'ArtifactDetailPage withholds the previous artifact; `after` is same-list paging, which intentionally keeps the current page.',
  },
  {
    call: 'apps/web/src/features/blocks/BlockUsage.tsx :: blocks.usage :: [artifactId]',
    reason: 'Only rendered under a keyed artifact or approval read that unmounts it while the new id loads.',
  },
  {
    call: 'apps/web/src/features/broadcasts/composer/useComposerData.ts :: purposes.list :: [refreshKey]',
    reason: 'Explicit refresh counter: the purpose/provider/DNS reads are the same configuration refreshed in place.',
  },
  {
    call: 'apps/web/src/features/broadcasts/composer/useComposerData.ts :: system.status :: [refreshKey]',
    reason: 'Explicit refresh counter: the purpose/provider/DNS reads are the same configuration refreshed in place.',
  },
  {
    call: 'apps/web/src/features/broadcasts/composer/useComposerData.ts :: sendingDomains.list :: [refreshKey]',
    reason: 'Explicit refresh counter: the purpose/provider/DNS reads are the same configuration refreshed in place.',
  },
  {
    call: 'apps/web/src/features/broadcasts/names.ts :: ? :: [workspace.id, type]',
    reason: 'A workspace/type name cache; a lookup for a new id misses rather than showing the old name under it.',
  },
  {
    call: 'apps/web/src/features/broadcasts/report/CampaignHoldout.tsx :: campaigns.of :: [artifactId]',
    reason: 'ArtifactDetailPage withholds the previous artifact and unmounts the report while the keyed read loads.',
  },
  {
    call: 'apps/web/src/features/campaigns/phase26/CampaignEvaluationView.tsx :: analytics.campaignSummary :: [campaignId, bounds.from, bounds.to, refreshKey, localRefresh]',
    reason: 'The summary replaces its panel on refreshing, so a new campaign or period never shows the old numbers.',
  },
  {
    call: 'apps/web/src/features/campaigns/phase26/CampaignHoldoutView.tsx :: campaigns.holdoutResult :: [campaignId, bounds.from, bounds.to, hasControl, hasGoal, refreshKey]',
    reason: 'The result replaces its panel on refreshing, so a new campaign or period never shows the old result.',
  },
  {
    call: 'apps/web/src/features/deliverability/DeliverabilityView.tsx :: deliverability.health :: [refreshKey]',
    reason: 'health is an explicit refresh; domains change only when selectors are applied, and dnsKey is an explicit refresh.',
  },
  {
    call: 'apps/web/src/features/deliverability/DeliverabilityView.tsx :: sendingDomains.list :: [appliedSelectors, dnsKey]',
    reason: 'health is an explicit refresh; domains change only when selectors are applied, and dnsKey is an explicit refresh.',
  },
  {
    call: 'apps/web/src/features/journey/Inspector.tsx :: webhookList :: [workspaceId]',
    reason: 'Workspace switch reloads the session/shell; these workspace-scoped picker lists are filtered by id before use.',
  },
  {
    call: 'apps/web/src/features/journey/Inspector.tsx :: connectionList :: [workspaceId]',
    reason: 'Workspace switch reloads the session/shell; these workspace-scoped picker lists are filtered by id before use.',
  },
  {
    call: 'apps/web/src/features/journey/Inspector.tsx :: trackingPlanList :: [workspaceId]',
    reason: 'Workspace switch reloads the session/shell; these workspace-scoped picker lists are filtered by id before use.',
  },
  {
    call: 'apps/web/src/features/journey/report/JourneyReport.tsx :: artifacts.get :: [journeyId]',
    reason:
      'The report sits under ArtifactDetailPage, which unmounts it while the keyed artifact read loads; stats and funnel gate on refreshing.',
  },
  {
    call: 'apps/web/src/features/journey/report/JourneyReport.tsx :: artifacts.get :: [journeyId, pinnedVersion, artifact?.version.number]',
    reason:
      'The report sits under ArtifactDetailPage, which unmounts it while the keyed artifact read loads; stats and funnel gate on refreshing.',
  },
  {
    call: 'apps/web/src/features/journey/report/JourneyReport.tsx :: journeys.stats :: [journeyId, refresh]',
    reason:
      'The report sits under ArtifactDetailPage, which unmounts it while the keyed artifact read loads; stats and funnel gate on refreshing.',
  },
  {
    call: 'apps/web/src/features/journey/report/JourneyReport.tsx :: analytics.journeyFunnel :: [journeyId, period.from, period.to]',
    reason:
      'The report sits under ArtifactDetailPage, which unmounts it while the keyed artifact read loads; stats and funnel gate on refreshing.',
  },
  {
    call: 'apps/web/src/features/phase27/content/ContentList.tsx :: fetchAllArtifacts :: [type]',
    reason: 'The type comes from the route; a different artifact type is a different page component, never an in-place change.',
  },
  {
    call: 'apps/web/src/pages/build/BroadcastPage.tsx :: broadcasts.status :: [id]',
    reason: 'BroadcastPageForId is mounted with key={params.id}, so the id never changes in place.',
  },
  {
    call: 'apps/web/src/pages/build/BroadcastsPage.tsx :: broadcasts.list :: [cursor, filter.param]',
    reason: 'Each response is tagged with its cursor and status filter and only the matching page is read; busy is list.refreshing.',
  },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function skipString(source: string, at: number): number {
  const quote = source[at];
  let i = at + 1;
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function skipComment(source: string, at: number): number {
  if (source[at] === '/' && source[at + 1] === '/') {
    let i = at;
    while (i < source.length && source[i] !== '\n') i++;
    return i;
  }
  if (source[at] === '/' && source[at + 1] === '*') {
    let i = at + 2;
    while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
    return i + 2;
  }
  return -1;
}

function findMatching(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === '`') {
      i = skipString(source, i) - 1;
      continue;
    }
    const comment = skipComment(source, i);
    if (comment >= 0) {
      i = comment - 1;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split a call's arguments at top-level commas, ignoring strings and comments. */
function splitTop(source: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === '`') {
      i = skipString(source, i) - 1;
      continue;
    }
    const comment = skipComment(source, i);
    if (comment >= 0) {
      i = comment - 1;
      continue;
    }
    if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char)) depth--;
    else if (char === ',' && depth === 0) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out.map((part) => part.trim());
}

function commandOf(fn: string): string {
  const called = /api\.call\(\s*'([^']+)'/.exec(fn);
  if (called) return called[1]!;
  if (/fetchAllArtifacts\(\s*'?[^')\s]*'?\)/.test(fn)) return 'fetchAllArtifacts';
  const identifier = /^\s*([A-Za-z_$][\w$]*)/.exec(fn);
  return identifier?.[1] ?? '?';
}

function callSites(): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    const pattern = /(?<![\w.])useApi\s*\(/g;
    for (const match of source.matchAll(pattern)) {
      const open = source.indexOf('(', match.index);
      const close = findMatching(source, open);
      if (close < 0) continue;
      const [fn = '', second = ''] = splitTop(source.slice(open + 1, close));
      const literal = /^\[([\s\S]*)\]$/.exec(second.trim());
      const inner = literal ? literal[1]! : second;
      const deps = splitTop(inner).filter(Boolean);
      const flagged = deps.filter((dep) => ID_LIKE.test(dep));
      if (!flagged.length) continue;
      sites.push({
        file: relative(ROOT, file).split('\\').join('/'),
        command: commandOf(fn),
        deps: second.replace(/\s+/g, ' '),
        line: source.slice(0, match.index).split('\n').length,
        flagged,
      });
    }
  }
  return sites;
}

const keyOf = (site: Pick<Site, 'file' | 'command' | 'deps'>) => `${site.file} :: ${site.command} :: ${site.deps}`;

describe('useApi is not used for an id, filter or period read (#596, #611, #612, #617, #618, #619)', () => {
  const sites = callSites();
  const kept = new Set(KEPT.map((entry) => entry.call));

  it('finds the source files and their keyed-looking calls', () => {
    expect(sites.length).toBeGreaterThan(20);
  });

  it('has judged every call whose deps identify a different read', () => {
    const unjudged = sites.filter((site) => !kept.has(keyOf(site)));
    expect(
      unjudged.map((site) => `${site.file}:${site.line} (${site.command}) deps [${site.flagged.join(', ')}]`),
      'Use useKeyedApi, or add the call to KEPT with the reason its screen already withholds the old value.',
    ).toEqual([]);
  });

  it('keeps no stale allowlist entry', () => {
    const present = new Set(sites.map(keyOf));
    expect(KEPT.filter((entry) => !present.has(entry.call)).map((entry) => entry.call)).toEqual([]);
  });

  it('flags an id-like dependency but not a refresh counter or a plain deps list', () => {
    const deps = (text: string) => splitTop(text).filter((dep) => ID_LIKE.test(dep));
    expect(deps('agentId')).toEqual(['agentId']);
    expect(deps('filterKey')).toEqual(['filterKey']);
    expect(deps('days')).toEqual(['days']);
    expect(deps('period.from, period.to')).toEqual(['period.from', 'period.to']);
    expect(deps('resolvedId')).toEqual(['resolvedId']);
  });
});
