import { type FakeRequest, fakeLlm } from '@agentic-marketing/ai/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHostedAgentsOnce } from '../src/agents/hosted';
import { connectAgent, startTestServer, testPort, type User } from './harness';

// Wave 4, Phase 21 (#340): hosted agents keep a bounded, inspectable memory and follow published
// skills. A run writes notes for itself; the next run's prompt contains them, the published skills
// it references, and the business context and learnings when they exist. Memory refuses personal
// data and the cap, people edit and delete notes, and one agent never touches another's memory.

const PORT = testPort(2503);
const DAY = 86_400_000;
/** Beyond every schedule (a weekly run is at most seven days away). */
const DUE = () => new Date(Date.now() + 8 * DAY);

type Server = Awaited<ReturnType<typeof startTestServer>>;
let t: Server;
let llm: Awaited<ReturnType<typeof fakeLlm>>;

/** The hosted agent the fake model writes a note for, set before a run. */
let memoryTarget: string | null = null;

function answer(r: FakeRequest) {
  if (r.user.includes('[remember]') && r.toolResults.length === 0 && memoryTarget) {
    return {
      toolCalls: [
        {
          name: 'agents__memory__add',
          input: { agentId: memoryTarget, text: 'The Tuesday issue goes out at 07:00; last week the numbered subject won.' },
        },
      ],
    };
  }
  if (r.toolResults.length === 0) return { toolCalls: [{ name: 'agents__get', input: {} }] };
  return { text: 'Done. Remembered what matters and used the skills that apply.' };
}

const deps = () => ({
  db: t.srv.db,
  executor: t.srv.executor,
  kp: t.srv.keyProvider,
  email: t.srv.email,
  directory: t.srv.directory,
  publicUrl: t.base,
});

const runAt = (now: Date) => runHostedAgentsOnce(deps(), now);

/** Keep the other tests' hosted agents out of this sweep, and make this one due. */
const onlyDue = (agentId: string) =>
  t.srv.db.admin.query(
    `UPDATE hosted_agents SET next_run_at = CASE WHEN agent_id = $1 THEN now() - interval '1 minute' ELSE 'infinity' END`,
    [agentId],
  );

interface Setup {
  owner: User;
  ws: string;
  api: ReturnType<Server['api']>;
  agentId: string;
}

let unique = 0;

async function setup(instructions: string, scopes: string[] = ['artifacts:read', 'artifacts:write']): Promise<Setup> {
  const n = ++unique;
  const owner = await t.signUp(`owner-memory-${n}-${Date.now()}@example.com`);
  const ws = await t.workspaceWith([[owner, 'owner']], 'none');
  const api = t.api(owner, ws);
  await api.call('emailProviders.create', {
    name: 'Outbox',
    adapter: 'log',
    fromEmail: 'agents@example.com',
    useFor: ['transactional'],
  });
  await api.call('aiProviders.create', {
    name: 'Model',
    kind: 'anthropic-compatible',
    baseUrl: llm.baseUrl,
    models: { default: 'claude-sonnet-test' },
    apiKey: 'sk-test-0123456789',
    useFor: ['copilot'],
  });
  const hosted = await api.call('agents.createHosted', {
    name: `Memory agent ${n}`,
    instructions,
    schedule: 'daily:07:00',
    scopes: scopes as never,
    maxToolCallsPerRun: 10,
  });
  return { owner, ws, api, agentId: hosted.agentId };
}

async function createSkill(s: Setup, name: string, instructions: string) {
  return s.api.call('artifacts.create', {
    type: 'skill',
    name,
    content: { title: name, instructions, tags: ['newsletter'] },
  });
}

beforeAll(async () => {
  llm = await fakeLlm(answer);
  t = await startTestServer('test_hosted_memory', PORT);
}, 120_000);

afterAll(async () => {
  await t?.close();
  await llm?.close();
});

describe('hosted memory and skills (#340)', () => {
  it('stores a note a run writes for itself, created by that run', async () => {
    const s = await setup('[remember] Note what works for next week.');
    memoryTarget = s.agentId;
    await onlyDue(s.agentId);
    const summary = await runAt(DUE());
    expect(summary).toMatchObject({ due: 1, ok: 1, failed: 0 });

    const memory = await s.api.call('agents.memory.list', { agentId: s.agentId });
    expect(memory.count).toBe(1);
    expect(memory.characters).toBeGreaterThan(0);
    expect(memory.limits).toEqual({ notes: 50, characters: 10_000 });
    expect(memory.notes[0]).toMatchObject({
      agentId: s.agentId,
      text: expect.stringContaining('Tuesday issue'),
      createdBy: { type: 'run', id: expect.stringMatching(/^har_[0-9a-f]{32}$/) },
    });
  }, 60_000);

  it('puts the notes, the published skills, the business context and the active learnings in the next run’s prompt', async () => {
    const s = await setup('[recall] Use what you remember and the skills that apply.');
    memoryTarget = s.agentId;
    const note = await s.api.call('agents.memory.add', { agentId: s.agentId, text: 'The Tuesday issue goes out at 07:00.' });

    // One published skill and one draft: only the published instructions are used.
    const published = await createSkill(s, 'Subject lines that get opened', 'PUBLISHED SKILL: put the number in the first three words.');
    await s.api.call('artifacts.requestPublish', { artifactId: published.artifactId, note: 'reviewed' });
    const draft = await createSkill(s, 'Unreviewed advice', 'DRAFT SKILL: never send this yet.');
    await s.api.call('agents.updateHosted', { agentId: s.agentId, skills: [published.artifactId, draft.artifactId] });

    // The workspace brief and one evidence-backed conclusion, both published by people.
    const brief = await s.api.call('artifacts.create', {
      type: 'business_context',
      name: 'Business context',
      content: { summary: 'A weekly newsletter for marketing operations people.', voice: 'Plain and specific.' },
    });
    await s.api.call('artifacts.requestPublish', { artifactId: brief.artifactId, note: 'brief' });
    await s.api.call('learnings.add', {
      statement: 'Subject lines with a number win for this audience',
      scope: { channel: 'email' },
      evidence: [
        {
          kind: 'subject_test',
          id: `bct_${'a'.repeat(32)}`,
          summary: 'The numbered subject won on clicks',
          numbers: { wins: 3, tests: 4 },
        },
      ],
    });

    await onlyDue(s.agentId);
    const before = llm.requests.length;
    const summary = await runAt(DUE());
    expect(summary.ok).toBe(1);
    const prompt = llm.requests.slice(before)[0]!.user;
    expect(prompt).toContain('Your instructions:');
    expect(prompt).toContain('The Tuesday issue goes out at 07:00.');
    expect(prompt).toContain('Memory: notes this agent wrote for itself');
    expect(prompt).toContain('PUBLISHED SKILL');
    expect(prompt).not.toContain('DRAFT SKILL');
    expect(prompt).toContain('Business context');
    expect(prompt).toContain('A weekly newsletter for marketing operations people.');
    expect(prompt).toContain('Active learnings');
    expect(prompt).toContain('Subject lines with a number win for this audience');

    // The note is still there; the run did not need to rewrite it.
    const memory = await s.api.call('agents.memory.list', { agentId: s.agentId });
    expect(memory.notes.map((n) => n.id)).toContain(note.id);
  }, 60_000);

  it('refuses a note with an e-mail address or a phone number', async () => {
    const s = await setup('Keep notes.');
    await expect(
      s.api.call('agents.memory.add', { agentId: s.agentId, text: 'Ask jane.doe@example.com about the issue.' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('personal data') });
    await expect(
      s.api.call('agents.memory.add', { agentId: s.agentId, text: 'Call +45 12 34 56 78 before the send.' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('personal data') });
    expect((await s.api.call('agents.memory.list', { agentId: s.agentId })).count).toBe(0);
  }, 30_000);

  it('refuses the 51st note and a note that would pass 10,000 characters', async () => {
    const s = await setup('Keep notes.');
    await t.srv.db.admin.query(
      `INSERT INTO hosted_agent_memory (workspace_id, id, agent_id, text, created_by_user_id)
       SELECT $1, 'hmm_' || lpad(g::text, 32, '0'), $2, 'note ' || g, $3 FROM generate_series(1, 50) g`,
      [s.ws, s.agentId, s.owner.id],
    );
    await expect(s.api.call('agents.memory.add', { agentId: s.agentId, text: 'One more.' })).rejects.toMatchObject({
      message: expect.stringContaining('50 memory notes'),
    });

    const full = await setup('Keep notes.');
    await t.srv.db.admin.query(
      `INSERT INTO hosted_agent_memory (workspace_id, id, agent_id, text, created_by_user_id)
       SELECT $1, 'hmm_' || lpad(g::text, 32, '0'), $2, repeat('x', 1000), $3 FROM generate_series(1, 10) g`,
      [full.ws, full.agentId, full.owner.id],
    );
    await expect(full.api.call('agents.memory.add', { agentId: full.agentId, text: 'One more.' })).rejects.toMatchObject({
      message: expect.stringContaining('characters of memory'),
    });
  }, 30_000);

  it('lets a person delete a note and keeps the other notes', async () => {
    const s = await setup('Keep notes.');
    const first = await s.api.call('agents.memory.add', { agentId: s.agentId, text: 'The send window opens at 06:00.' });
    await s.api.call('agents.memory.add', { agentId: s.agentId, text: 'Use the shorter preheader.' });
    expect((await s.api.call('agents.memory.list', { agentId: s.agentId })).count).toBe(2);

    await s.api.call('agents.memory.delete', { id: first.id });
    const memory = await s.api.call('agents.memory.list', { agentId: s.agentId });
    expect(memory.count).toBe(1);
    expect(memory.notes[0]!.text).toBe('Use the shorter preheader.');
  }, 30_000);

  it('never lets another agent write to this agent’s memory', async () => {
    const s = await setup('Keep notes.');
    const other = await connectAgent(t.base, s.owner, ['artifacts:read']);
    try {
      const result = (await other.client.callTool({
        name: 'agents.memory.add',
        arguments: { agentId: s.agentId, text: 'Written by the wrong agent.' },
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('only read and change its own memory');
      expect((await s.api.call('agents.memory.list', { agentId: s.agentId })).count).toBe(0);
    } finally {
      await other.client.close();
    }
  }, 60_000);
});
