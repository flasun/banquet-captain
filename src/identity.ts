import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The Sprite's identity: an Ed25519 key pair made on the Sprite. The owner
 * approves the public key on the hub's /agents page; from then on every
 * check-in, heartbeat and check-out is signed, and the board shows the lease as
 * "verified (signed)".
 *
 * This is an identity key, not a service credential: it opens nothing outside
 * the hub's agent board, and the hub only accepts it for this agent id.
 *
 * The signing format mirrors flasun/hub src/modules/agents/signing.ts:
 *   hub-agent-v1 \n tool \n agent(lowercase) \n at \n nonce \n sha256hex(canonical(args without signature))
 */

export const SIG_VERSION = 'hub-agent-v1';

export interface CallSignature {
  readonly at: string;
  readonly nonce: string;
  readonly sig: string;
}

/** JSON with object keys sorted, undefined values and empty arrays left out, no whitespace. Matches the hub byte for byte. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined && !(Array.isArray(x) && x.length === 0))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
}

export function signingPayload(tool: string, agent: string, at: string, nonce: string, args: Record<string, unknown>): string {
  const { signature: _drop, ...rest } = args;
  const digest = createHash('sha256').update(canonical(rest)).digest('hex');
  return [SIG_VERSION, tool, agent.toLowerCase(), at, nonce, digest].join('\n');
}

export function newNonce(): string {
  return randomBytes(24).toString('base64url'); // 32 chars of [A-Za-z0-9_-]
}

export class Identity {
  private constructor(private readonly privateKey: KeyObject) {}

  static path(home: string): string {
    return join(home, 'identity.pem');
  }

  static exists(home: string): boolean {
    return existsSync(Identity.path(home));
  }

  /** Load the key, or make one on first run. The private key never leaves this file. */
  static loadOrCreate(home: string): { identity: Identity; created: boolean } {
    const file = Identity.path(home);
    if (existsSync(file)) return { identity: new Identity(createPrivateKey(readFileSync(file, 'utf8'))), created: false };
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    chmodSync(file, 0o600);
    return { identity: new Identity(privateKey), created: true };
  }

  static load(home: string): Identity | null {
    const file = Identity.path(home);
    return existsSync(file) ? new Identity(createPrivateKey(readFileSync(file, 'utf8'))) : null;
  }

  static fromKey(privateKey: KeyObject): Identity {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Identity key must be Ed25519.');
    return new Identity(privateKey);
  }

  /** 32 raw bytes, base64url: the form agent_key_register accepts. */
  publicKeyRaw(): string {
    const jwk = createPublicKey(this.privateKey).export({ format: 'jwk' }) as { x?: string };
    if (!jwk.x) throw new Error('Could not export the public key.');
    return jwk.x;
  }

  /** Same fingerprint the hub shows on /agents, so the owner can match it before approving. */
  fingerprint(): string {
    return `SHA256:${createHash('sha256').update(Buffer.from(this.publicKeyRaw(), 'base64url')).digest('base64url').slice(0, 22)}`;
  }

  signCall(tool: string, agent: string, args: Record<string, unknown>, now: Date = new Date()): CallSignature {
    const at = now.toISOString();
    const nonce = newNonce();
    const sig = sign(null, Buffer.from(signingPayload(tool, agent, at, nonce, args), 'utf8'), this.privateKey).toString('base64url');
    return { at, nonce, sig };
  }
}
