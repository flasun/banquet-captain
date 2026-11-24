import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Captain's config holds addresses and names only. It never holds a credential:
 * every outside call goes through the Sprites API gateway, which attaches the
 * stored credential on the way out. loadConfig() refuses to start if the config
 * or the environment looks like it carries one.
 */
export interface CaptainConfig {
  /** Agent id on the hub. Must equal the name of the hub key stored in the hub connector. */
  readonly agentId: string;
  /** Gateway base for the hub connector, e.g. https://api.sprites.dev/v1/gateway/<provider>/<connection_id> */
  readonly hubGatewayUrl: string;
  /** Hub compartment path behind the gateway. Work holds projects, tasks and agent check-ins. */
  readonly hubPath: string;
  /** Only hub tasks carrying this tag are picked up. */
  readonly taskTag: string;
  /** Hub project slug the agent's leases are filed under (optional). */
  readonly project?: string;
  /** Shown on the agent board. */
  readonly surface: string;
  /** Heartbeat while working. The hub's rule is at least every 2h; Captain beats far more often. */
  readonly heartbeatMinutes: number;
  /** While awake, poll the hub this often. Wake-on-request handles the rest. */
  readonly pollMinutes: number;
  /** auto: sign when an identity key exists, fall back to unsigned only while the hub has no approved key. */
  readonly signing: 'auto' | 'required' | 'off';
  /** HTTP port. Sprites route their URL to 8080. */
  readonly port: number;
  /** Where key, state and work live. */
  readonly home: string;
}

export const CAPTAIN_HOME = process.env.CAPTAIN_HOME ?? join(homedir(), '.captain');
export const CONFIG_PATH = join(CAPTAIN_HOME, 'config.json');

const DEFAULTS = {
  hubPath: '',
  taskTag: 'captain',
  surface: 'Fly.io Sprite',
  heartbeatMinutes: 10,
  pollMinutes: 5,
  signing: 'auto',
  port: 8080,
} as const;

/** Prefixes of credentials Captain should never see. Seeing one means the setup is wrong. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /hubk_[A-Za-z0-9_-]{8,}/, // hub API key
  /alt_[A-Za-z0-9_-]{16,}/, // hub lease token (lives in state, never config)
  /sk-ant-[A-Za-z0-9_-]{8,}/, // Anthropic
  /sk-[A-Za-z0-9]{20,}/, // OpenAI-style
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/, // Slack
];

const ENV_NAMES_TO_FLAG: readonly RegExp[] = [/^HUB_(TOKEN|KEY)$/, /^ANTHROPIC_API_KEY$/, /^OPENAI_API_KEY$/, /^GH_TOKEN$/, /^GITHUB_TOKEN$/, /^PUSHOVER_.*TOKEN$/];

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function findCredentialLeaks(text: string): string[] {
  return CREDENTIAL_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

/** Names (never values) of environment variables that look like credentials. */
export function credentialEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  const hits: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    // ANTHROPIC_API_KEY=gateway is the documented placeholder when Claude Code talks to the Anthropic connector.
    if (name === 'ANTHROPIC_API_KEY' && value === 'gateway') continue;
    if (ENV_NAMES_TO_FLAG.some((re) => re.test(name)) || findCredentialLeaks(value).length) hits.push(name);
  }
  return hits.sort();
}

function str(raw: Record<string, unknown>, key: string, fallback?: string): string {
  const v = process.env[`CAPTAIN_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`] ?? raw[key] ?? fallback;
  if (typeof v !== 'string' || !v.trim()) throw new ConfigError(`config: "${key}" is required (set it in ${CONFIG_PATH}).`);
  return v.trim();
}

/** Path appended to the gateway URL. Empty when the connector's base URL already ends at the MCP endpoint (the default setup). */
function urlPath(raw: Record<string, unknown>, key: string, fallback: string): string {
  const envName = `CAPTAIN_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
  const v = process.env[envName] ?? raw[key] ?? fallback;
  if (typeof v !== 'string') throw new ConfigError(`config: "${key}" must be a string.`);
  const t = v.trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/[?#]|\.\./.test(t)) throw new ConfigError(`config: "${key}" must be a plain path with no query, fragment or "..".`);
  return t.startsWith('/') ? t : `/${t}`;
}

function num(raw: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const envName = `CAPTAIN_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
  const v = process.env[envName] !== undefined ? Number(process.env[envName]) : (raw[key] ?? fallback);
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new ConfigError(`config: "${key}" must be a number from ${min} to ${max}.`);
  return v;
}

export function loadConfig(path: string = CONFIG_PATH): CaptainConfig {
  if (!existsSync(path)) throw new ConfigError(`No config at ${path}. Run "captain init" first.`);
  const text = readFileSync(path, 'utf8');
  const leaks = findCredentialLeaks(text);
  if (leaks.length) throw new ConfigError(`config looks like it holds a credential (${leaks.join(', ')}). Credentials belong in a Sprites connector, never on the Sprite.`);
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    raw = parsed as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`config at ${path} is not valid JSON: ${(err as Error).message}`);
  }

  const agentId = str(raw, 'agentId');
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(agentId)) throw new ConfigError('config: "agentId" must match the hub\'s agent id rule: lowercase letters, digits, . _ -');
  const hubGatewayUrl = str(raw, 'hubGatewayUrl').replace(/\/+$/, '');
  const u = new URL(hubGatewayUrl);
  if (u.protocol !== 'https:') throw new ConfigError('config: "hubGatewayUrl" must be https.');
  if (u.username || u.password || u.search) throw new ConfigError('config: "hubGatewayUrl" must not carry credentials or a query.');
  const signing = str(raw, 'signing', DEFAULTS.signing);
  if (signing !== 'auto' && signing !== 'required' && signing !== 'off') throw new ConfigError('config: "signing" must be auto, required or off.');
  const project = typeof raw.project === 'string' && raw.project.trim() ? raw.project.trim() : undefined;

  return {
    agentId,
    hubGatewayUrl,
    hubPath: urlPath(raw, 'hubPath', DEFAULTS.hubPath),
    taskTag: str(raw, 'taskTag', DEFAULTS.taskTag),
    ...(project ? { project } : {}),
    surface: str(raw, 'surface', DEFAULTS.surface),
    heartbeatMinutes: num(raw, 'heartbeatMinutes', DEFAULTS.heartbeatMinutes, 1, 110),
    pollMinutes: num(raw, 'pollMinutes', DEFAULTS.pollMinutes, 1, 120),
    signing,
    port: num(raw, 'port', DEFAULTS.port, 1, 65535),
    home: CAPTAIN_HOME,
  };
}

export function configTemplate(agentId: string): string {
  return `${JSON.stringify(
    {
      agentId,
      hubGatewayUrl: 'https://api.sprites.dev/v1/gateway/REPLACE_PROVIDER/REPLACE_CONNECTION_ID',
      hubPath: DEFAULTS.hubPath,
      taskTag: DEFAULTS.taskTag,
      project: 'hub',
      surface: DEFAULTS.surface,
      heartbeatMinutes: DEFAULTS.heartbeatMinutes,
      pollMinutes: DEFAULTS.pollMinutes,
      signing: DEFAULTS.signing,
      port: DEFAULTS.port,
    },
    null,
    2,
  )}\n`;
}
