// 拆书导入管道（MD 2.1）：切章 → 时间归位 → 抽取（LLM 或降级启发式）→ 漏斗
import { EventStore, NewEventInput } from '@eventverse/core';
import { splitChapters, assignWorldTimes, timeLabel, newId, callLLM, extractJson, ProviderConfig } from '@eventverse/adapters';
import { Workspace } from './workspace.js';
import { runFunnel } from './funnel.js';
import { extractorSystemPrompt } from './prompts.js';
import { JobRegistry } from './jobs.js';

export interface ImportOptions {
  worldId: string;
  workTitle: string;
  text: string;
  baseYear?: number;              // 世界时间锚点（开篇 = 元年）
  extractorProvider: ProviderConfig;
  adversarialProvider: ProviderConfig;
  /** 每章跑 LLM 抽取的最大章数（超出用启发式），控制成本 */
  llmChapterBudget?: number;
  /** 复用外部已创建的 job（HTTP 层先返回 jobId 再异步执行） */
  jobId?: string;
  /** 断点续跑：复用既有 workId，跳过 cursor 之前的章节（MD §2.4） */
  resume?: { workId: string; cursor: number };
}

export interface ImportResult {
  workId: string;
  chapters: number;
  proposals: string[];
  eventsDirect: number;    // 作者级直接入库（章节锚点）
  resumedFrom?: number;
}

export async function importNovel(store: EventStore, ws: Workspace, jobs: JobRegistry, opts: ImportOptions): Promise<ImportResult> {
  const job = (opts.jobId ? jobs.get(opts.jobId) : null) ?? jobs.create('import', { worldId: opts.worldId, label: `拆书：${opts.workTitle}` });
  jobs.start(job.id);
  try {
    const signal = jobs.signal(job.id);
    const split = splitChapters(opts.text);
    const resumeFrom = opts.resume?.cursor ?? 0;
    const totalChapters = Math.max(split.length, resumeFrom);
    jobs.tick(job.id, { total: totalChapters + 1, cursor: resumeFrom, label: resumeFrom > 0 ? `续跑《${opts.workTitle}》自第 ${resumeFrom + 1} 章` : `拆书：${opts.workTitle}` });
    const workId = opts.resume?.workId ?? newId('work');
    const now = new Date().toISOString();
    if (!opts.resume) {
      store.createWork({ id: workId, worldId: opts.worldId, title: opts.workTitle, createdAt: now });
    }
    jobs.tick(job.id, { result: { workId } });
    const proposals: string[] = [];
    let eventsDirect = 0;
    const bodies = split.map(s => s.body);
    const times = assignWorldTimes(bodies, { baseYear: opts.baseYear ?? 1000 });

    for (let i = resumeFrom; i < split.length; i++) {
      if (signal?.aborted) { jobs.tick(job.id, { cursor: i }); throw new Error('cancelled'); }
      const ch = split[i];
      const chapterId = newId('ch');
      ws.writeChapterBody(workId, chapterId, ch.body);
      store.saveChapter({ id: chapterId, workId, title: ch.title, index: i, worldTime: times[i], worldTimeLabel: timeLabel(times[i]), kind: 'body', wordCount: ch.body.length });
      // 章节锚点事件（作者级直接入库——结构事实无需漏斗）
      store.append({
        worldId: opts.worldId, workId, worldTime: times[i], actor: 'author',
        kind: 'chapter.anchor', payload: { workId, chapterId, title: ch.title },
        sourceRef: 'import', review: { status: 'approved' },
      });
      eventsDirect++;

      // 抽取：预算内用 LLM，超出/失败降级启发式
      const budget = opts.llmChapterBudget ?? 20;
      let events = i < budget
        ? await llmExtract(opts.extractorProvider, ch.body, times[i], signal)
        : [];
      if (!events.length) events = heuristicExtract(ch.body, times[i]);

      if (events.length) {
        const p = await runFunnel(store, opts.worldId, events, opts.adversarialProvider, `拆书《${opts.workTitle}》第${i + 1}章`);
        proposals.push(p.id);
      }
      jobs.tick(job.id, { progress: i + 1, cursor: i + 1, label: `拆书 ${i + 1}/${split.length}：${ch.title}` });
    }
    jobs.done(job.id, { workId, chapters: split.length, proposals: proposals.length, resumedFrom: resumeFrom || undefined });
    return { workId, chapters: split.length, proposals, eventsDirect, resumedFrom: resumeFrom || undefined };
  } catch (e: any) {
    jobs.fail(job.id, String(e?.message ?? e));
    throw e;
  }
}

async function llmExtract(provider: ProviderConfig, body: string, worldTime: number, signal?: AbortSignal): Promise<NewEventInput[]> {
  try {
    const res = await callLLM(provider, [
      { role: 'system', content: extractorSystemPrompt() },
      { role: 'user', content: body.slice(0, 12000) },
    ], { temperature: 0.1, maxTokens: 2000, signal });
    const j = extractJson(res.content);
    const events: NewEventInput[] = [];
    for (const ev of j?.events ?? []) {
      if (!ev?.kind || !ev?.payload) continue;
      events.push({
        worldId: '', actor: 'agent', worldTime,
        kind: ev.kind, payload: normalizePayload(ev.kind, ev.payload),
        sourceRef: 'llm-extract',
      });
    }
    return events;
  } catch {
    return [];
  }
}

function normalizePayload(kind: string, p: any): any {
  const q = { ...p };
  // 允许 LLM 用人名指代角色：保留 name 语义（funnel 的自动校验会用名字解析）
  if (kind === 'char.create' && !q.id) q.id = q.name;
  if ((kind === 'relation.set') && q.validFrom == null) q.validFrom = 0;
  if (kind === 'fact.set' && q.validFrom == null) q.validFrom = 0;
  return q;
}

/** 启发式抽取降级：引号对白中的称呼、引号前的"XX道/说"模式 —— 提供最低限度的候选 */
export function heuristicExtract(body: string, worldTime: number): NewEventInput[] {
  const out: NewEventInput[] = [];
  const seen = new Set<string>();
  const pat = /([\u4e00-\u9fa5]{2,4})(?:说|道|问|喊|冷笑|低声)/g;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(body)) !== null) {
    const name = m[1];
    if (seen.has(name) || ['他们', '她们', '我们', '自己', '众人'].includes(name)) continue;
    seen.add(name);
    out.push({ worldId: '', actor: 'agent', worldTime, kind: 'char.create', payload: { id: name, name, attrs: { 来源: '启发式抽取' } }, sourceRef: 'heuristic' });
  }
  return out.slice(0, 12);
}
