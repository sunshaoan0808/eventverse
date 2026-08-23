// Jobs 系统（MD 2.4）：断点续跑（章节级游标）、进度 SSE、取消
import { randomUUID } from 'node:crypto';

export interface JobInfo {
  id: string; kind: string; worldId?: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  progress: number; total: number; label: string;
  result?: any; error?: string;
  createdAt: string; updatedAt: string;
  /** 章节级游标——恢复时跳过已处理章节（断点续跑） */
  cursor?: number;
}

export class JobRegistry {
  jobs = new Map<string, JobInfo>();
  private controllers = new Map<string, AbortController>();
  private listeners = new Map<string, Set<(j: JobInfo) => void>>();

  create(kind: string, opts: { worldId?: string; total?: number; label?: string } = {}): JobInfo {
    const j: JobInfo = {
      id: `job-${randomUUID().slice(0, 10)}`, kind, worldId: opts.worldId,
      status: 'queued', progress: 0, total: opts.total ?? 0, label: opts.label ?? kind,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    this.jobs.set(j.id, j);
    this.controllers.set(j.id, new AbortController());
    return j;
  }
  start(id: string) { this.update(id, { status: 'running' }); }
  tick(id: string, patch: Partial<JobInfo>) { this.update(id, patch); }
  update(id: string, patch: Partial<JobInfo>) {
    const j = this.jobs.get(id);
    if (!j) return;
    Object.assign(j, patch, { updatedAt: new Date().toISOString() });
    this.listeners.get(id)?.forEach(fn => fn({ ...j }));
  }
  done(id: string, result?: any) { this.update(id, { status: 'done', result }); }
  fail(id: string, error: string) { this.update(id, { status: 'error', error }); }
  cancel(id: string) {
    this.controllers.get(id)?.abort();
    const j = this.jobs.get(id);
    if (j && j.status === 'queued' || j?.status === 'running') this.update(id, { status: 'cancelled' });
  }
  signal(id: string): AbortSignal | undefined { return this.controllers.get(id)?.signal; }
  get(id: string) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

  subscribe(id: string, fn: (j: JobInfo) => void): () => void {
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(fn);
    return () => this.listeners.get(id)?.delete(fn);
  }
}
