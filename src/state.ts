import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Local memory across sleeps and restarts. The Sprite's disk survives sleep, so
 * this file is how Captain knows, on wake, which lease it holds and which
 * decisions it left waiting on the owner.
 *
 * Lease tokens live here (mode 600). They are hub-scoped, short-lived, and only
 * renew or close a lease this agent already holds.
 */

export interface ActiveWork {
  readonly leaseId: string;
  readonly token: string;
  readonly taskId: string;
  readonly taskTitle: string;
  readonly startedAt: string;
}

export interface WaitingItem {
  readonly leaseId: string;
  readonly taskId: string;
  readonly taskTitle: string;
  /** Task on the owner's Waiting list, e.g. "task:tk_abc"; null when the hub did not report one. */
  readonly waitingTask: string | null;
  readonly question: string;
  readonly at: string;
}

export interface CaptainState {
  active: ActiveWork | null;
  waiting: WaitingItem[];
  lastTickAt: string | null;
}

const EMPTY: CaptainState = { active: null, waiting: [], lastTickAt: null };

export class StateStore {
  private readonly file: string;

  constructor(home: string) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    this.file = join(home, 'state.json');
  }

  read(): CaptainState {
    if (!existsSync(this.file)) return structuredClone(EMPTY);
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<CaptainState>;
      return { active: v.active ?? null, waiting: Array.isArray(v.waiting) ? v.waiting : [], lastTickAt: v.lastTickAt ?? null };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  /** Atomic write: a crash mid-write never leaves half a file. */
  write(state: CaptainState): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  update(fn: (s: CaptainState) => void): CaptainState {
    const s = this.read();
    fn(s);
    this.write(s);
    return s;
  }
}
