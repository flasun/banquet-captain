import type { CaptainConfig } from './config.ts';
import { HubError, type HubClient } from './hub.ts';
import type { Identity } from './identity.ts';

/**
 * Leases on the hub's agent board, under the owner's rules:
 *   - check in before touching anything, naming the records it will write;
 *   - heartbeat at least every 2h (Captain beats every few minutes while working);
 *   - over 4h silent = MIA, and another agent may take the work with its notes;
 *   - waiting on the owner = check out with what it needs; no MIA clock runs,
 *     the item lands on the Waiting on Ryan list, and any agent resumes it later.
 */

export interface Lease {
  readonly id: string;
  readonly token: string;
  readonly takeover: readonly LeaseNotes[];
  readonly resumed: LeaseNotes | null;
}

export interface LeaseNotes {
  readonly lease?: string;
  readonly agent?: string;
  readonly progress?: string | null;
  readonly next?: string | null;
  readonly waiting_on?: string | null;
}

export interface CheckinInput {
  readonly work: string;
  readonly next?: string;
  readonly refs?: readonly string[];
  readonly resume?: string;
}

export type ReleaseStatus = 'done' | 'handoff' | 'waiting' | 'blocked';

export interface ReleaseResult {
  /** For waiting: the task on the owner's Waiting list, e.g. "task:tk_abc". */
  readonly waitingTask: string | null;
}

export class LeaseConflict extends Error {
  override readonly name = 'LeaseConflict';
}

const NO_KEY = /has no approved signing key/;

export class Leases {
  /** Set once the hub says this agent has no approved key, so auto mode stops trying until restart. */
  private unsignedOk = false;

  constructor(
    private readonly hub: HubClient,
    private readonly cfg: Pick<CaptainConfig, 'agentId' | 'surface' | 'project' | 'signing'>,
    private readonly identity: Identity | null,
  ) {
    if (cfg.signing === 'required' && !identity) throw new Error('signing is "required" but there is no identity key. Run "captain init".');
  }

  private shouldSign(): boolean {
    return this.cfg.signing !== 'off' && this.identity !== null && !this.unsignedOk;
  }

  /** Strip undefined and trim strings, so the args we sign are the args the hub checks. */
  private static clean(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (v === undefined) continue;
      out[k] = typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : x)) : v;
    }
    return out;
  }

  private async signedCall<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    const clean = Leases.clean(args);
    if (!this.shouldSign() || !this.identity) return this.hub.call<T>(tool, clean);
    const signature = this.identity.signCall(tool, this.cfg.agentId, clean);
    try {
      return await this.hub.call<T>(tool, { ...clean, signature });
    } catch (err) {
      if (this.cfg.signing === 'auto' && err instanceof HubError && NO_KEY.test(err.message)) {
        this.unsignedOk = true; // key registered but not approved yet: run unsigned, show as "key" identity
        return this.hub.call<T>(tool, clean);
      }
      throw err;
    }
  }

  async checkin(input: CheckinInput): Promise<Lease> {
    const r = await this.signedCall<{
      checked_in?: boolean;
      lease?: { id?: string };
      token?: string;
      conflicts?: { agent?: string; work?: string }[];
      takeover?: LeaseNotes[];
      resumed?: LeaseNotes | null;
    }>('agent_checkin', {
      agent: this.cfg.agentId,
      surface: this.cfg.surface,
      project: this.cfg.project,
      work: input.work,
      next: input.next,
      refs: input.refs ? [...input.refs] : undefined,
      resume: input.resume,
    });
    if (!r.checked_in || !r.lease?.id || !r.token) {
      const who = (r.conflicts ?? []).map((c) => `${c.agent ?? '?'} (${c.work ?? ''})`).join('; ');
      throw new LeaseConflict(who ? `Held by another live agent: ${who}` : 'Check-in was refused.');
    }
    return { id: r.lease.id, token: r.token, takeover: r.takeover ?? [], resumed: r.resumed ?? null };
  }

  async heartbeat(lease: Lease, progress: string, next?: string): Promise<void> {
    await this.signedCall('agent_heartbeat', { agent: this.cfg.agentId, token: lease.token, progress, next });
  }

  async release(lease: Lease, status: ReleaseStatus, update: string, extra: { next?: string; waitingOn?: string } = {}): Promise<ReleaseResult> {
    if ((status === 'waiting' || status === 'blocked') && !extra.waitingOn) throw new Error(`${status} needs waitingOn.`);
    if (status === 'handoff' && !extra.next) throw new Error('handoff needs next.');
    const r = await this.signedCall<Record<string, unknown>>('agent_release', {
      agent: this.cfg.agentId,
      token: lease.token,
      status,
      update,
      next: extra.next,
      waiting_on: extra.waitingOn,
    });
    return { waitingTask: findTaskRef(r) };
  }
}

/** The release result's shape may grow; look for the first task ref anywhere in it. */
export function findTaskRef(v: unknown): string | null {
  if (typeof v === 'string') return /^task:[A-Za-z0-9_-]+$/.test(v) ? v : null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const hit = findTaskRef(x);
      if (hit) return hit;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) {
      const hit = findTaskRef(x);
      if (hit) return hit;
    }
  }
  return null;
}
