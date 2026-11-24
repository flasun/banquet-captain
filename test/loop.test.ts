import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { credentialEnvNames, findCredentialLeaks, loadConfig, type CaptainConfig } from '../src/config.ts';
import { HubClient, type FetchLike } from '../src/hub.ts';
import { Leases } from '../src/lease.ts';
import { Captain } from '../src/loop.ts';
import { StateStore } from '../src/state.ts';
import { Tasks, type HubTask } from '../src/tasks.ts';
import { DryRunWorker } from '../src/work.ts';

/** A tiny stand-in for the hub's Work compartment: tasks plus the agent board's lease rules. */
class FakeHub {
  tasks: (HubTask & { tags: string[] })[] = [{ id: 'tk_1', title: 'Bump the README badge', status: 'todo', tags: ['captain'], notes: '' }];
  leases = new Map<string, { agent: string; token: string; state: 'active' | 'waiting' | 'done' | 'handoff'; refs: string[] }>();
  calls: { tool: string; args: Record<string, unknown>; auth: string | null }[] = [];
  private n = 0;

  fetch: FetchLike = async (_url, init) => {
    const headers = new Headers(init.headers);
    const msg = JSON.parse(String(init.body)) as { id: number; method: string; params: { name?: string; arguments?: Record<string, unknown> } };
    if (msg.method === 'tools/list') return this.reply(msg.id, { tools: ['agent_checkin', 'agent_heartbeat', 'agent_release', 'ws_task_list', 'ws_task_update', 'agent_board'].map((name) => ({ name })) });
    const tool = msg.params.name ?? '';
    const args = msg.params.arguments ?? {};
    this.calls.push({ tool, args, auth: headers.get('authorization') });
    try {
      return this.reply(msg.id, { content: [{ type: 'text', text: JSON.stringify(this.run(tool, args)) }] });
    } catch (err) {
      return this.reply(msg.id, { content: [{ type: 'text', text: (err as Error).message }], isError: true });
    }
  };

  private reply(id: number, result: unknown): Promise<Response> {
    return Promise.resolve(new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }

  private run(tool: string, a: Record<string, unknown>): unknown {
    switch (tool) {
      case 'ws_task_list': {
        const statuses = (a.status as string[] | undefined) ?? ['todo', 'doing', 'blocked'];
        return this.tasks.filter((t) => statuses.includes(t.status) && (!a.tag || t.tags.includes(a.tag as string)));
      }
      case 'ws_task_update': {
        for (const u of a.updates as { id: string; status?: HubTask['status'] }[]) {
          const t = this.tasks.find((x) => x.id === u.id);
          if (t && u.status) Object.assign(t, { status: u.status });
        }
        return { updated: true };
      }
      case 'agent_checkin': {
        const refs = (a.refs as string[] | undefined) ?? [];
        if (a.resume) {
          const old = this.leases.get(a.resume as string);
          if (!old || old.state !== 'waiting') throw new Error('nothing to resume');
          old.state = 'done';
        }
        for (const l of this.leases.values()) if (l.state === 'active' && l.refs.some((r) => refs.includes(r))) return { checked_in: false, conflicts: [{ agent: l.agent, work: 'x' }] };
        const id = `al_${++this.n}`;
        const token = `alt_${'t'.repeat(20)}${this.n}`;
        this.leases.set(id, { agent: a.agent as string, token, state: 'active', refs });
        return { checked_in: true, lease: { id }, token, takeover: [], resumed: a.resume ? { lease: a.resume, progress: 'p', next: 'n' } : null };
      }
      case 'agent_heartbeat':
        return { ok: true };
      case 'agent_release': {
        const lease = [...this.leases.entries()].find(([, l]) => l.token === a.token);
        if (!lease) throw new Error('bad token');
        lease[1].state = a.status as 'waiting';
        if (a.status === 'waiting') {
          const id = `tk_w${this.n}`;
          this.tasks.push({ id, title: `[waiting-on-ryan] ${a.waiting_on as string}`, status: 'todo', tags: ['waiting-on-ryan', 'agents'], notes: '' });
          return { lease: { id: lease[0], ask: `task:${id}` } };
        }
        return { lease: { id: lease[0], ask: null } };
      }
      default:
        throw new Error(`unknown tool ${tool}`);
    }
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'captain-'));
  const cfg: CaptainConfig = { agentId: 'banquet-captain', hubGatewayUrl: 'https://api.sprites.dev/v1/gateway/custom/conn_test', hubPath: '/mcp/work', taskTag: 'captain', surface: 'test', heartbeatMinutes: 10, pollMinutes: 5, signing: 'off', port: 8080, home };
  const fake = new FakeHub();
  const hub = new HubClient(cfg, fake.fetch);
  const state = new StateStore(home);
  const captain = new Captain(cfg, new Leases(hub, cfg, null), new Tasks(hub), state, new DryRunWorker(), () => undefined);
  return { fake, state, captain };
}

test('full cycle: claim, wait on the owner, resume on yes, finish', async () => {
  const { fake, state, captain } = setup();

  const first = await captain.tick();
  assert.equal(first.action, 'worked');
  assert.equal(fake.tasks[0]?.status, 'blocked');
  const waiting = state.read().waiting;
  assert.equal(waiting.length, 1);
  assert.match(waiting[0]?.waitingTask ?? '', /^task:tk_w/);
  assert.equal(state.read().active, null);

  // Nothing decided yet: the next tick finds no work and does not ask twice.
  assert.equal((await captain.tick()).action, 'idle');

  // Owner marks the Waiting-list item done.
  const item = fake.tasks.find((t) => t.tags.includes('waiting-on-ryan'));
  assert.ok(item);
  Object.assign(item, { status: 'done' });

  const third = await captain.tick();
  assert.equal(third.action, 'resumed');
  assert.equal(fake.tasks[0]?.status, 'done');
  assert.equal(state.read().waiting.length, 0);

  // No call ever carried an Authorization header: the gateway adds credentials.
  assert.ok(fake.calls.every((c) => c.auth === null));
});

test('owner says no: task is parked, not asked again', async () => {
  const { fake, captain } = setup();
  await captain.tick();
  const item = fake.tasks.find((t) => t.tags.includes('waiting-on-ryan'));
  assert.ok(item);
  Object.assign(item, { status: 'dropped' });
  assert.equal((await captain.tick()).action, 'resumed');
  assert.equal(fake.tasks[0]?.status, 'blocked');
  assert.equal((await captain.tick()).action, 'idle');
});

test('a task held by another live agent is skipped', async () => {
  const { fake, captain } = setup();
  fake.leases.set('al_other', { agent: 'someone-else', token: 'alt_other_token_xxxxxxxx', state: 'active', refs: ['task:tk_1'] });
  assert.equal((await captain.tick()).action, 'idle');
  assert.equal(fake.tasks[0]?.status, 'todo');
});

test('config refuses credentials, and env check names them without values', () => {
  const home = mkdtempSync(join(tmpdir(), 'captain-cfg-'));
  const file = join(home, 'config.json');
  writeFileSync(file, JSON.stringify({ agentId: 'banquet-captain', hubGatewayUrl: 'https://api.sprites.dev/v1/gateway/x/y', note: 'hubk_abcdefghijklmnop' }));
  assert.throws(() => loadConfig(file), /credential/);
  writeFileSync(file, JSON.stringify({ agentId: 'banquet-captain', hubGatewayUrl: 'https://api.sprites.dev/v1/gateway/x/y' }));
  assert.equal(loadConfig(file).hubPath, '/mcp/work');
  assert.deepEqual(findCredentialLeaks('nothing here'), []);
  assert.deepEqual(credentialEnvNames({ PATH: '/bin', GITHUB_TOKEN: 'x', OTHER: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa', ANTHROPIC_API_KEY: 'gateway' }), ['GITHUB_TOKEN', 'OTHER']);
});
