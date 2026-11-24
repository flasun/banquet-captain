import type { HubClient } from './hub.ts';

/** Hub workspace tasks, as ws_task_list returns them. Fields beyond these are ignored. */
export interface HubTask {
  readonly id: string;
  readonly title: string;
  readonly status: 'todo' | 'doing' | 'blocked' | 'done' | 'dropped';
  readonly notes?: string | null;
  readonly tags?: readonly string[];
  readonly priority?: number;
  readonly due_on?: string | null;
}

export const WAITING_TAG = 'waiting-on-ryan';

function asTasks(v: unknown): HubTask[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' && Array.isArray((v as { tasks?: unknown }).tasks) ? (v as { tasks: unknown[] }).tasks : [];
  return list.filter((t): t is HubTask => !!t && typeof t === 'object' && typeof (t as HubTask).id === 'string' && typeof (t as HubTask).title === 'string');
}

export class Tasks {
  constructor(private readonly hub: HubClient) {}

  /** Tasks Captain may work: tagged for it, open, and not themselves Waiting-list items. In the hub's order (due date, then priority). */
  async candidates(tag: string): Promise<HubTask[]> {
    const r = await this.hub.call('ws_task_list', { tag, status: ['todo', 'doing'], limit: 50 });
    return asTasks(r).filter((t) => !(t.tags ?? []).includes(WAITING_TAG));
  }

  /** Find a task by id among a set of statuses. The hub has no single-task read on this compartment yet. */
  async find(id: string, statuses: HubTask['status'][], tag?: string): Promise<HubTask | null> {
    const r = await this.hub.call('ws_task_list', { status: statuses, limit: 200, ...(tag ? { tag } : {}) });
    return asTasks(r).find((t) => t.id === id) ?? null;
  }

  async setStatus(id: string, status: HubTask['status']): Promise<void> {
    await this.hub.call('ws_task_update', { updates: [{ id, status }] });
  }
}

export function taskRef(id: string): string {
  return id.startsWith('task:') ? id : `task:${id}`;
}

export function taskId(ref: string): string {
  return ref.startsWith('task:') ? ref.slice(5) : ref;
}
