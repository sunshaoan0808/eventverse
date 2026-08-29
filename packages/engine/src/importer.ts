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
  /** 主抽取模型失败/空结果时的回退模型（免费节点轮动时提升成功率） */
  fallbackExtractorProvider?: ProviderConfig;
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
    let applied = 0;
    const bodies = split.map(s => s.body);
    const times = assignWorldTimes(bodies, { baseYear: opts.baseYear ?? 1000 });
    // 跨章人物名去重：同一名字只在首次出现时提案（消灭提案洪水，MD §5.3）
    const globalSeen = new Set<string>();
    const seedNames = buildSeedNames(opts.text);
    for (let i = 0; i < split.length; i++) {
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

      // 抽取：预算内用 LLM，超出/失败降级启发式（启发式带全局人物名去重）
      const budget = opts.llmChapterBudget ?? 20;
      let events = i < budget
        ? await llmExtract(opts.extractorProvider, ch.body, times[i], signal, globalSeen, seedNames, opts.text, opts.fallbackExtractorProvider)
        : [];
      if (!events.length) events = heuristicExtract(ch.body, times[i], globalSeen, seedNames);

      if (events.length) {
        const p = await runFunnel(store, opts.worldId, events, opts.adversarialProvider, `拆书《${opts.workTitle}》第${i + 1}章`);
        proposals.push(p.id);
        if (p.status === 'approved') { store.applyProposal(p.id); applied++; }
        else {
          // 兜底：坏关系/移动会拖死整批，但人物注册低风险——单独落库，其余留队列人工审
          for (const ev of p.events as any[]) {
            if (ev.kind !== 'char.create' || !ev.payload?.name) continue;
            store.append({
              worldId: opts.worldId, workId: ev.workId, worldTime: ev.worldTime, actor: 'agent',
              kind: 'char.create', payload: ev.payload, sourceRef: p.id,
              review: { status: 'approved', by: 'import-char-fallback' },
            });
            applied++;
          }
        }
      }
      jobs.tick(job.id, { progress: i + 1, cursor: i + 1, label: `拆书 ${i + 1}/${split.length}：${ch.title}` });
    }
    jobs.done(job.id, { workId, chapters: split.length, proposals: proposals.length, applied, resumedFrom: resumeFrom || undefined });
    return { workId, chapters: split.length, proposals, eventsDirect, resumedFrom: resumeFrom || undefined };
  } catch (e: any) {
    jobs.fail(job.id, String(e?.message ?? e));
    throw e;
  }
}

async function llmExtract(provider: ProviderConfig, body: string, worldTime: number, signal?: AbortSignal, globalSeen?: Set<string>, seedNames?: Set<string>, fullText?: string, fallbackProvider?: ProviderConfig): Promise<NewEventInput[]> {
  // 免费节点轮动：主模型失败/空结果时用回退模型再试一次
  let events = await llmExtractOnce(provider, body, worldTime, signal, globalSeen, seedNames, fullText);
  if (!events.length && fallbackProvider && fallbackProvider.id !== provider.id) {
    events = await llmExtractOnce(fallbackProvider, body, worldTime, signal, globalSeen, seedNames, fullText);
  }
  return events;
}

async function llmExtractOnce(provider: ProviderConfig, body: string, worldTime: number, signal?: AbortSignal, globalSeen?: Set<string>, seedNames?: Set<string>, fullText?: string): Promise<NewEventInput[]> {
  try {
    const res = await callLLM(provider, [
      { role: 'system', content: extractorSystemPrompt() },
      { role: 'user', content: body.slice(0, 12000) },
    ], { temperature: 0.1, maxTokens: 2000, signal });
    const j = extractJson(res.content);
    const events: NewEventInput[] = [];
    for (const ev of j?.events ?? []) {
      if (!ev?.kind || !ev?.payload) continue;
      const np = normalizePayload(ev.kind, ev.payload);
      // 残次过滤：空名/空值/超长乱码直接丢弃（免费小模型常见）
      const core = [np.id, np.name, np.value, np.place, np.from, np.to, np.charId, np.description].filter(v => v != null);
      if (!core.length || core.some(v => String(v).trim() === '')) continue;
      const freqName = np.name ?? np.id;
      // 白名单只卡 char.create（幻觉新角色是提案洪水源头）；其余 kind 交漏斗自动校验判定
      if (seedNames && ev.kind === 'char.create') {
        const refNames = [np.name, np.id].filter(v => typeof v === 'string' && v);
        if (refNames.length && refNames.some(n => !seedNames.has(n))) continue;
      }
      if (fullText && freqName && ev.kind.startsWith('char.') && fullText.split(String(freqName)).length - 1 < 3) continue; // 幻觉人名全书查无 → 丢弃
      if (ev.kind === 'char.create' && globalSeen) {
        const nm = np.name ?? np.id;
        if (nm && globalSeen.has(nm)) continue;
        if (nm) globalSeen.add(nm);
      }
      events.push({
        worldId: '', actor: 'agent', worldTime,
        kind: ev.kind, payload: np,
        sourceRef: 'llm-extract',
      });
    }
    return events;
  } catch {
    return [];
  }
}

/** 载荷别名归一：免费小模型常见字段错位 → 引擎标准字段（types.ts schema） */
const PAYLOAD_ALIASES: Record<string, Record<string, string>> = {
  'location.move': { charId: 'charId', character: 'charId', who: 'charId', place: 'place', location: 'place', to: 'place', target: 'place' },
  'relation.set': { from: 'from', source: 'from', subject: 'from', a: 'from', to: 'to', target: 'to', object: 'to', b: 'to' },
  'relation.end': { id: 'id' },
  'char.create': { id: 'id', name: 'name' },
  'char.update': { id: 'id' },
  'char.death': { id: 'id', name: 'id' },
  'item.transfer': { holder: 'holder' },
};

function normalizePayload(kind: string, p: any): any {
  const q: any = { ...p };
  const alias = PAYLOAD_ALIASES[kind];
  if (alias) {
    for (const [from, to] of Object.entries(alias)) {
      if (q[from] === undefined && q[to] === undefined) continue;
      if (q[to] === undefined && q[from] !== undefined && from !== to) q[to] = q[from];
    }
  }
  if ((kind === 'char.create') && !q.id) q.id = q.name;
  if ((kind === 'char.death' || kind === 'char.update') && q.id == null && q.name) q.id = q.name;
  if (kind === 'relation.set' && q.validFrom == null) q.validFrom = 0;
  if (kind === 'fact.set' && q.validFrom == null) q.validFrom = 0;
  return q;
}

/** 人物名白名单：全书频次 + 前后缀黑名单（防句式碎片与幻觉名）。LLM 与启发式共用。 */
const LEADING_BAD = /^[对着跟和与向给被让把冲朝找从往叫拉推带扶望看听想觉得令使他她它不没就还都也再到在说很太真好若便即就才只又候脱提]/;
const TRAILING_BAD = /[知道经话了吗呢吧的就行去来在地说着了地得出而以之乎者只会都也还再又]/;

export function collectCharCandidates(text: string): string[] {
  const out = new Set<string>();
  const pat = /([\u4e00-\u9fa5]{2,4})(?:说|道|问|喊)(?=\s*[:：“"])/g;
  let m: RegExpExecArray | null;
  while ((m = pat.exec(text)) !== null) out.add(m[1]);
  return [...out];
}

export function buildSeedNames(text: string, minFreq = 5): Set<string> {
  const seed = new Set<string>();
  for (const name of collectCharCandidates(text)) {
    if (LEADING_BAD.test(name) || TRAILING_BAD.test(name)) continue;
    if (text.split(name).length - 1 < minFreq) continue;
    seed.add(name);
  }
  // 含已收录真名的碎片剔除（"对郭靖""郭靖怀里"）
  for (const name of [...seed]) {
    for (const other of seed) {
      if (other !== name && name.length > other.length && name.includes(other)) { seed.delete(name); break; }
    }
  }
  // 以真名首二字/末字开头的错切剔除（"狐冲赶快""令狐导""靖期期艾艾"）
  for (const name of [...seed]) {
    for (const other of seed) {
      if (other !== name && name.length > other.length && (name.startsWith(other.slice(0, 2)) || name.startsWith(other.slice(-1)))) { seed.delete(name); break; }
    }
  }
  return seed;
}

/** 启发式抽取降级：只产白名单内、且本章出场的人物 */
export function heuristicExtract(body: string, worldTime: number, globalSeen?: Set<string>, seedNames?: Set<string>): NewEventInput[] {
  if (!seedNames) return [];
  const out: NewEventInput[] = [];
  const seen = new Set<string>(globalSeen ?? []);
  for (const name of seedNames) {
    if (seen.has(name) || !body.includes(name)) continue;
    seen.add(name);
    globalSeen?.add(name);
    out.push({ worldId: '', actor: 'agent', worldTime, kind: 'char.create', payload: { id: name, name, attrs: { 来源: '启发式抽取' } }, sourceRef: 'heuristic' });
  }
  return out.slice(0, 12);
}
