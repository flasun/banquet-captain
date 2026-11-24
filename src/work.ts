import type { LeaseNotes } from './lease.ts';
import type { HubTask } from './tasks.ts';

/**
 * What Captain does with a task once it holds the lease. The loop owns leases,
 * heartbeats and the Waiting list; a Worker only does the work and says how it
 * ended.
 */

export interface WorkContext {
  readonly task: HubTask;
  /** Notes handed over by the hub when this lease resumed a waiting item or took over an MIA one. */
  readonly handedOver: readonly LeaseNotes[];
  /** For a resumed waiting item: the owner's decision. */
  readonly answer: OwnerAnswer | null;
  /** Report progress; the loop turns it into a heartbeat. */
  readonly progress: (note: string, next?: string) => Promise<void>;
  readonly signal: AbortSignal;
}

export interface OwnerAnswer {
  /** done on the Waiting list = go ahead; dropped = no. */
  readonly decision: 'yes' | 'no';
  /** The Waiting-list task's notes, which is where the owner can write more than yes or no. */
  readonly notes: string;
}

export type WorkOutcome =
  | { readonly kind: 'done'; readonly summary: string }
  | { readonly kind: 'needs-owner'; readonly question: string; readonly progress: string; readonly next: string }
  | { readonly kind: 'handoff'; readonly progress: string; readonly next: string };

export interface Worker {
  readonly name: string;
  run(ctx: WorkContext): Promise<WorkOutcome>;
}

/**
 * Day 1 worker: exercises the whole lease cycle without touching anything but
 * the hub. It claims a task, reports progress, asks the owner once, and on a
 * yes finishes. Day 2 swaps in the worker that runs Claude Code in a scratch
 * clone and opens a PR through the GitHub connector.
 */
export class DryRunWorker implements Worker {
  readonly name = 'dry-run';

  async run(ctx: WorkContext): Promise<WorkOutcome> {
    const { task, answer } = ctx;
    if (!answer) {
      await ctx.progress(`Read "${task.title}". Dry run: no files touched.`, 'Ask the owner before doing real work.');
      return {
        kind: 'needs-owner',
        question: `Dry run on "${task.title}": OK to treat this as done? Mark this item done for yes, drop it for no.`,
        progress: 'Claimed the task and checked in; nothing changed outside the hub.',
        next: 'On yes, close the task as done. On no, put it back.',
      };
    }
    if (answer.decision === 'no') {
      return { kind: 'handoff', progress: 'Owner said no on the dry run.', next: 'Leave the task for a person or a later worker.' };
    }
    await ctx.progress('Owner said yes. Closing out.');
    return { kind: 'done', summary: `Dry run finished on "${task.title}" after the owner's yes.` };
  }
}
