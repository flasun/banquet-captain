import type { CaptainConfig } from './config.ts';
import { HubError } from './hub.ts';
import { LeaseConflict, type Lease, type Leases, type LeaseNotes } from './lease.ts';
import type { StateStore, WaitingItem } from './state.ts';
import { taskId, taskRef, type HubTask, type Tasks } from './tasks.ts';
import type { OwnerAnswer, Worker, WorkOutcome } from './work.ts';

export type Log = (msg: string) => void;

export interface TickResult {
  readonly action: 'resumed' | 'worked' | 'idle' | 'busy' | 'skipped';
  readonly detail: string;
}

/**
 * One pass of the agent. Safe to call on every wake: it holds at most one lease
 * at a time, and a second call while one runs returns "busy".
 *
 * Order each tick:
 *   1. a decision the owner made on the Waiting list -> resume that lease;
 *   2. otherwise the first open task tagged for Captain -> check in and work it.
 * A task another live agent holds is skipped; one held by an MIA agent is taken
 * over by the hub with its notes, which the worker receives.
 */
export class Captain {
  private running = false;

  constructor(
    private readonly cfg: CaptainConfig,
    private readonly leases: Leases,
    private readonly tasks: Tasks,
    private readonly state: StateStore,
    private readonly worker: Worker,
    private readonly log: Log = (m) => console.log(`[captain] ${m}`),
  ) {}

  async tick(): Promise<TickResult> {
    if (this.running) return { action: 'busy', detail: 'A tick is already running.' };
    this.running = true;
    try {
      this.state.update((s) => {
        s.lastTickAt = new Date().toISOString();
      });
      const stale = this.state.read().active;
      if (stale) {
        // We restarted or woke holding a lease. Hand it back with notes rather than guess where the work stopped.
        await this.releaseStale(stale.leaseId, stale.token, stale.taskTitle);
      }
      const resumed = await this.resumeDecided();
      if (resumed) return resumed;
      return await this.workNext();
    } finally {
      this.running = false;
    }
  }

  private async releaseStale(leaseId: string, token: string, title: string): Promise<void> {
    const lease: Lease = { id: leaseId, token, takeover: [], resumed: null };
    try {
      await this.leases.release(lease, 'handoff', `Captain restarted while working "${title}".`, { next: 'Pick the task up again from its last progress note.' });
      this.log(`handed back stale lease ${leaseId}`);
    } catch (err) {
      this.log(`stale lease ${leaseId} already closed or taken over: ${(err as Error).message}`);
    }
    this.state.update((s) => {
      s.active = null;
    });
  }

  /** A waiting item is decided when its Waiting-list task is done (yes) or dropped (no). */
  private async resumeDecided(): Promise<TickResult | null> {
    for (const item of this.state.read().waiting) {
      if (!item.waitingTask) continue;
      const t = await this.tasks.find(taskId(item.waitingTask), ['done', 'dropped']);
      if (!t) continue;
      const answer: OwnerAnswer = { decision: t.status === 'done' ? 'yes' : 'no', notes: t.notes ?? '' };
      this.log(`owner decided "${item.question}": ${answer.decision}`);
      const task = (await this.tasks.find(item.taskId, ['todo', 'doing', 'blocked'])) ?? { id: item.taskId, title: item.taskTitle, status: 'blocked' as const };
      let lease: Lease;
      try {
        lease = await this.leases.checkin({ work: `Resume "${item.taskTitle}" after the owner's ${answer.decision}`, refs: [taskRef(item.taskId)], resume: item.leaseId });
      } catch (err) {
        if (err instanceof LeaseConflict || err instanceof HubError) {
          this.log(`could not resume ${item.leaseId}: ${err.message}`);
          this.forgetWaiting(item);
          continue;
        }
        throw err;
      }
      this.forgetWaiting(item);
      const handed = lease.resumed ? [lease.resumed] : [];
      await this.runOn(task, lease, handed, answer);
      return { action: 'resumed', detail: `${item.taskTitle}: ${answer.decision}` };
    }
    return null;
  }

  private forgetWaiting(item: WaitingItem): void {
    this.state.update((s) => {
      s.waiting = s.waiting.filter((w) => w.leaseId !== item.leaseId);
    });
  }

  private async workNext(): Promise<TickResult> {
    const waitingIds = new Set(this.state.read().waiting.map((w) => w.taskId));
    const candidates = (await this.tasks.candidates(this.cfg.taskTag)).filter((t) => !waitingIds.has(t.id));
    for (const task of candidates) {
      let lease: Lease;
      try {
        lease = await this.leases.checkin({ work: `Work hub task "${task.title}"`, next: 'Read the task and start.', refs: [taskRef(task.id)] });
      } catch (err) {
        if (err instanceof LeaseConflict) {
          this.log(`skip "${task.title}": ${err.message}`);
          continue;
        }
        throw err;
      }
      if (lease.takeover.length) this.log(`took over "${task.title}" from an MIA agent`);
      await this.runOn(task, lease, lease.takeover, null);
      return { action: 'worked', detail: task.title };
    }
    return { action: 'idle', detail: `No open tasks tagged "${this.cfg.taskTag}".` };
  }

  private async runOn(task: HubTask, lease: Lease, handedOver: readonly LeaseNotes[], answer: OwnerAnswer | null): Promise<void> {
    this.state.update((s) => {
      s.active = { leaseId: lease.id, token: lease.token, taskId: task.id, taskTitle: task.title, startedAt: new Date().toISOString() };
    });
    if (task.status !== 'doing') await this.tasks.setStatus(task.id, 'doing');

    let lastNote = 'Started.';
    const beat = setInterval(() => {
      this.leases.heartbeat(lease, `Still working: ${lastNote}`).catch((err: unknown) => this.log(`heartbeat failed: ${(err as Error).message}`));
    }, this.cfg.heartbeatMinutes * 60_000);
    const abort = new AbortController();

    let outcome: WorkOutcome;
    try {
      outcome = await this.worker.run({
        task,
        handedOver,
        answer,
        signal: abort.signal,
        progress: async (note, next) => {
          lastNote = note;
          await this.leases.heartbeat(lease, note, next);
        },
      });
    } catch (err) {
      outcome = { kind: 'handoff', progress: `Worker failed: ${(err as Error).message}`.slice(0, 900), next: 'Look at the error, then retry the task.' };
    } finally {
      clearInterval(beat);
      abort.abort();
    }

    await this.finish(task, lease, outcome, answer);
    this.state.update((s) => {
      s.active = null;
    });
  }

  private async finish(task: HubTask, lease: Lease, outcome: WorkOutcome, answer: OwnerAnswer | null): Promise<void> {
    switch (outcome.kind) {
      case 'done':
        await this.tasks.setStatus(task.id, 'done');
        await this.leases.release(lease, 'done', outcome.summary);
        this.log(`done: ${task.title}`);
        return;
      case 'needs-owner': {
        await this.tasks.setStatus(task.id, 'blocked');
        const r = await this.leases.release(lease, 'waiting', outcome.progress, { next: outcome.next, waitingOn: outcome.question });
        this.state.update((s) => {
          s.waiting.push({ leaseId: lease.id, taskId: task.id, taskTitle: task.title, waitingTask: r.waitingTask, question: outcome.question, at: new Date().toISOString() });
        });
        this.log(`waiting on owner: ${outcome.question}${r.waitingTask ? ` (${r.waitingTask})` : ' (hub reported no Waiting-list item)'}`);
        // Day 3: push a one-line ping to the owner's phone through the Pushover connector here.
        return;
      }
      case 'handoff':
        // After an owner's no, park the task as blocked so the next tick does not ask the same question again.
        await this.tasks.setStatus(task.id, answer?.decision === 'no' ? 'blocked' : 'todo');
        await this.leases.release(lease, 'handoff', outcome.progress, { next: outcome.next });
        this.log(`handed off: ${task.title}`);
        return;
    }
  }
}
