#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { CAPTAIN_HOME, CONFIG_PATH, ConfigError, configTemplate, credentialEnvNames, loadConfig, type CaptainConfig } from './config.ts';
import { HubClient, HubError } from './hub.ts';
import { Identity } from './identity.ts';
import { Leases } from './lease.ts';
import { Captain } from './loop.ts';
import { startServer } from './server.ts';
import { StateStore } from './state.ts';
import { Tasks } from './tasks.ts';
import { DryRunWorker } from './work.ts';

const USAGE = `captain <command>

  init [agent-id]   make the identity key and a config template (agent id defaults to the Sprite's hostname)
  doctor            check: no credentials on this machine, config, identity, and the hub through the gateway
  register-key      ask the hub owner to approve this Sprite's public key (approve it on the hub's /agents page)
  tick              run one pass: resume a decided item or work the next tagged task
  serve             run on :8080; POST /wake runs a tick, and it polls while awake
  status            show the lease Captain holds and what waits on the owner`;

const log = (m: string) => console.log(`[captain] ${m}`);

function build(cfg: CaptainConfig) {
  const hub = new HubClient(cfg);
  const identity = Identity.load(cfg.home);
  const leases = new Leases(hub, cfg, identity);
  const state = new StateStore(cfg.home);
  const captain = new Captain(cfg, leases, new Tasks(hub), state, new DryRunWorker(), log);
  return { hub, identity, leases, state, captain };
}

function refuseIfCredentials(): void {
  const names = credentialEnvNames();
  if (names.length) {
    throw new ConfigError(`These environment variables look like credentials: ${names.join(', ')}. Unset them; Captain reaches every service through a Sprites connector.`);
  }
}

async function init(agentArg?: string): Promise<void> {
  mkdirSync(CAPTAIN_HOME, { recursive: true, mode: 0o700 });
  const agentId = (agentArg ?? process.env.HOSTNAME ?? 'banquet-captain').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 63);
  const { identity, created } = Identity.loadOrCreate(CAPTAIN_HOME);
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, configTemplate(agentId), { mode: 0o600 });
    log(`wrote ${CONFIG_PATH}: set hubGatewayUrl to the hub connector's gateway URL`);
  } else log(`kept existing ${CONFIG_PATH}`);
  log(`${created ? 'made' : 'kept'} identity key at ${Identity.path(CAPTAIN_HOME)} (private, stays on this Sprite)`);
  console.log(`\nagent id:     ${agentId}\npublic key:   ${identity.publicKeyRaw()}\nfingerprint:  ${identity.fingerprint()}\n`);
  console.log('Next: fill in hubGatewayUrl, run "captain doctor", then "captain register-key" and approve the fingerprint above on the hub.');
}

async function doctor(): Promise<number> {
  let bad = 0;
  const ok = (m: string) => console.log(`  ok    ${m}`);
  const fail = (m: string) => {
    bad++;
    console.log(`  FAIL  ${m}`);
  };
  const names = credentialEnvNames();
  if (names.length) fail(`credential-like environment variables: ${names.join(', ')}`);
  else ok('no credential-like environment variables');

  let cfg: CaptainConfig;
  try {
    cfg = loadConfig();
    ok(`config ${CONFIG_PATH} (agent ${cfg.agentId}, tag "${cfg.taskTag}")`);
  } catch (err) {
    fail((err as Error).message);
    return 1;
  }
  const identity = Identity.load(cfg.home);
  if (identity) ok(`identity key ${identity.fingerprint()}`);
  else if (cfg.signing === 'required') fail('signing is "required" but there is no identity key');
  else console.log('  warn  no identity key yet: run "captain init"');

  const hub = new HubClient(cfg);
  try {
    const tools = await hub.listTools();
    const needed = ['agent_checkin', 'agent_heartbeat', 'agent_release', 'ws_task_list', 'ws_task_update'];
    const missing = needed.filter((t) => !tools.includes(t));
    if (missing.length) fail(`hub reached at ${hub.endpoint}, but these tools are missing (wrong compartment?): ${missing.join(', ')}`);
    else ok(`hub reached through the gateway at ${hub.endpoint} (${tools.length} tools)`);
    const board = await hub.call<{ rules?: { checkin_every_hours?: number; mia_after_hours?: number } }>('agent_board', { ended_hours: 0, window_days: 1 });
    ok(`agent board answers (check in every ${board.rules?.checkin_every_hours ?? '?'}h, MIA after ${board.rules?.mia_after_hours ?? '?'}h)`);
  } catch (err) {
    fail(err instanceof HubError ? err.message : `hub: ${(err as Error).message}`);
  }
  console.log(bad ? `\n${bad} problem(s).` : '\nAll good.');
  return bad ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'init':
      await init(rest[0]);
      return 0;
    case 'doctor':
      return doctor();
    case 'register-key': {
      const cfg = loadConfig();
      const identity = Identity.load(cfg.home);
      if (!identity) throw new ConfigError('No identity key. Run "captain init" first.');
      const r = await new HubClient(cfg).call('agent_key_register', { agent: cfg.agentId, public_key: identity.publicKeyRaw() });
      console.log(JSON.stringify(r, null, 2));
      console.log(`\nApprove fingerprint ${identity.fingerprint()} for "${cfg.agentId}" on the hub's /agents page.`);
      return 0;
    }
    case 'tick': {
      refuseIfCredentials();
      const r = await build(loadConfig()).captain.tick();
      log(`${r.action}: ${r.detail}`);
      return 0;
    }
    case 'serve': {
      refuseIfCredentials();
      const cfg = loadConfig();
      const { captain, state } = build(cfg);
      startServer({ port: cfg.port, agentId: cfg.agentId, captain, state, pollMinutes: cfg.pollMinutes, log });
      return new Promise<number>(() => undefined); // run until killed
    }
    case 'status': {
      const s = new StateStore(loadConfig().home).read();
      console.log(JSON.stringify({ working: s.active ? { task: s.active.taskTitle, lease: s.active.leaseId, since: s.active.startedAt } : null, waiting: s.waiting.map((w) => ({ task: w.taskTitle, question: w.question, item: w.waitingTask })), lastTickAt: s.lastTickAt }, null, 2));
      return 0;
    }
    default:
      console.log(USAGE);
      return cmd ? 2 : 0;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`[captain] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof ConfigError ? 2 : 1);
  },
);
