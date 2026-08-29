// 回合引擎（MD 3.2/3.3）：双 agent + beat 两段式 + 导演断言 + 文风检测 + TurnEnd 记账
import { EventStore, NewEventInput } from '@eventverse/core';
import { callLLM, extractJson, analyzeProse, ProviderConfig } from '@eventverse/adapters';
import { Workspace, ChatSession } from './workspace.js';
import { directorSystemPrompt, rendererSystemPrompt, extractorSystemPrompt, chatRewritePrompt } from './prompts.js';
import { runFunnel } from './funnel.js';
import { ToolContext, toolSpecs, executeTool, MAX_AGENT_TOOL_CALLS } from './tools.js';
import { PackStore, entryRolePrompt } from './packs.js';

export interface TurnEvent { type: string; data?: any }
export type Emit = (e: TurnEvent) => void;

export interface EngineDeps {
  store: EventStore;
  ws: Workspace;
  directorProvider: () => ProviderConfig;
  rendererProvider: () => ProviderConfig;
  extractorProvider: () => ProviderConfig;
  adversarialProvider: () => ProviderConfig;
}

function estimateCostUsd(p: ProviderConfig, inTok: number, outTok: number): number {
  // 粗略计量（按 provider 前缀区分家族费率），报表口径以 usage_log 为准
  const per1k = p.protocol === 'anthropic' ? { in: 0.003, out: 0.015 } : { in: 0.001, out: 0.002 };
  return Math.round((inTok / 1000 * per1k.in + outTok / 1000 * per1k.out) * 10000) / 10000;
}

function styleAnchorFrom(ws: Workspace, store: EventStore, workId: string | null, fromChapterId?: string): string | null {
  if (!workId) return null;
  const chapters = store.listChapters(workId);
  const ch = fromChapterId ? chapters.find(c => c.id === fromChapterId) : chapters[chapters.length - 1];
  if (!ch) return null;
  const body = ws.readChapterBody(workId, ch.id);
  if (!body || body.length < 200) return null;
  return body.slice(0, 600); // 三段以内足矣
}

/** 未回收伏笔压力（MD 3.3 解法②） */
function foreshadowPressure(store: EventStore, worldId: string): string[] {
  const s = store.stateAt(worldId);
  const now = s.asOf.worldTime;
  return s.foreshadowings
    .filter(f => f.recoveredAt == null)
    .sort((a, b) => (b.deadlineWorldTime ?? Infinity) - (a.deadlineWorldTime ?? Infinity) - (now - (a.deadlineWorldTime ?? Infinity)))
    .slice(0, 5)
    .map(f => `${f.description}（埋于 t=${f.plantedAt}${f.deadlineWorldTime != null ? `，期限 t=${f.deadlineWorldTime}${f.deadlineWorldTime < now ? '【已逾期，优先催收】' : ''}` : ''}）`);
}

function tensionBrief(store: EventStore, worldId: string): string {
  const s = store.stateAt(worldId);
  const chars = Object.values(s.characters);
  return `在册人物 ${chars.length}（死亡 ${chars.filter(c => c.isDead).length}），活跃关系 ${s.relations.length}，未回收伏笔 ${s.foreshadowings.filter(f => f.recoveredAt == null).length}，当前世界时间 t=${s.asOf.worldTime === -Infinity ? '未定' : s.asOf.worldTime}`;
}

export interface TurnResult {
  content: string;
  beats?: string[];
  options?: string[];
  idle: boolean;
  proposalIds: string[];
  prose: ReturnType<typeof analyzeProse>;
  costUsd: number;
}

/** RP 回合：beat 两段式（导演 → 渲染 → TurnEnd 记账 → idle 断言 → 文风检测）
 * 支持玩侧 StoryPack：optionIndex 命中节点选项（canon 硬跳/advance 推进/idle 不动） */
export async function runRpTurn(deps: EngineDeps, session: ChatSession, userMessage: string, emit: Emit, opts: { optionIndex?: number } = {}): Promise<TurnResult> {
  const { store, ws } = deps;
  const worldId = session.worldId;
  const profile = session.profile ?? { charId: null, focusCharId: null };
  const packs = new PackStore(ws.root);

  // ── 0. StoryPack 节点推进（引擎标签白名单：canon/advance/idle）──
  let packCtx = '';
  let packOptions: Array<{ text: string; tag?: string }> | null = null;
  if (profile.pack) {
    const pack = packs.get(profile.pack.packId);
    if (pack) {
      if (opts.optionIndex != null) {
        const r = packs.chooseOption(pack, profile.pack, opts.optionIndex);
        profile.pack = r.progress;
        session.profile = profile;
        ws.saveSession(session);
        if (r.note) emit({ type: 'pack_move', data: { note: r.note, jumpedCanon: r.jumpedCanon, nodeId: r.progress.nodeId } });
      }
      const at = packs.nodeOf(pack, profile.pack);
      if (at) {
        const charName = profile.charId ? (store.stateAt(worldId).characters[profile.charId]?.name ?? null) : null;
        packCtx = `\n【剧本包】《${pack.title}》· ${profile.pack.playMode === 'mainline' ? '主线' : '自由'}模式\n${entryRolePrompt(profile.pack.entryRole, charName)}\n当前节点（《${at.chapter.title}》t=${at.chapter.worldTime}）：${at.node.text.slice(0, 400)}\n改线强度：${profile.pack.rewriteIntensity === 'canon' ? '强原著骨架' : '允许大改'}；读者记忆：${profile.pack.metaKnowledge === 'reader' ? '知原著走向' : '无'}\n已访问节点数：${profile.pack.visitedNodes.length}`;
        if (profile.pack.playMode === 'mainline') {
          packOptions = at.node.options.map(o => ({ text: o.text, tag: o.tag }));
        }
      }
    }
  }

  const stateBefore = store.stateAt(worldId);
  const guidance = store.listGuidance(worldId).filter(g => g.active).map(g => `${g.title}：${g.description}`);
  const lastTurnIdle = session.turns.filter(t => t.role === 'assistant').at(-1)?.meta?.idle ?? false;

  // ── TRPG 骰子注入（MD 3.3 解法③）：>15 时导演应注入意外 ──
  const dice = 1 + Math.floor(Math.random() * 20);
  emit({ type: 'dice', data: { roll: dice } });

  // ── 1. 导演出 beat（执事 agent，便宜模型）──
  const directorP = deps.directorProvider();
  const directorSys = directorSystemPrompt({ tensionState: tensionBrief(store, worldId), foreshadowPressure: foreshadowPressure(store, worldId), lastTurnIdle, guidance })
    + (packCtx ? `\n（若提供【剧本包】信息，beat 必须服务于当前节点场景）` : '')
    + (dice > 15 ? `\n🎲 本回合骰子 d20=${dice}：必须在 beat 中注入一个意外事件打破预期。` : dice >= 10 ? `\n🎲 骰子 d20=${dice}：可引入轻微波动。` : '')
    + (store.latestPromptOverride(worldId, 'director') ? `\n【元层自进化覆盖】\n${store.latestPromptOverride(worldId, 'director')}` : '');
  let turnBrief = thisTurnBrief(store, session, userMessage) + packCtx;
  // 预算门：≥95% 预算先压缩会话（LLM 摘要，机械降级），再裁剪超长段
  const budgeted = await enforceBudget(deps, session, [directorSys, turnBrief]);
  const directorRes = await callLLM(directorP, [
    { role: 'system', content: directorSys },
    { role: 'user', content: budgeted[1] },
  ], { temperature: 0.9, maxTokens: 800 });
  logUsage(deps, worldId, 'director', directorP, directorRes.usage);
  const beat = extractJson(directorRes.content) ?? { beats: ['场景推进，信息揭示一层'], mustBreak: lastTurnIdle, tension: 0.5, options: [] };
  const beats: string[] = Array.isArray(beat.beats) ? beat.beats : [];
  emit({ type: 'beat', data: { beats, tension: beat.tension ?? null } });

  // 选项：mainline 模式以节点选项为准（引擎白名单标签），free 模式用导演选项
  const nodeOptions = packOptions ?? [];
  const aiOptions: string[] = Array.isArray(beat.options) ? beat.options.slice(0, 4) : [];
  const options: string[] = nodeOptions.length ? nodeOptions.map(o => o.tag ? `${o.text}（${o.tag}）` : o.text) : aiOptions;

  // ── 2. 渲染层写正文（强模型，零工具，沉浸）──
  const rendererP = deps.rendererProvider();
  const charName = profile.charId ? (stateBefore.characters[profile.charId]?.name ?? null) : null;
  const focusName = profile.focusCharId ? (stateBefore.characters[profile.focusCharId]?.name ?? null) : null;
  // in_scene（MD §9 补遗）：在场集合 = 与玩家同位置者；秘密的"当场发生"事实对同场者临时可见
  const present = presentCharsAt(stateBefore, profile.charId);
  const visibleState = profile.charId ? store.stateVisibleTo(worldId, profile.charId, undefined, present) : stateBefore;
  const rendererRes = await callLLM(rendererP, [
    { role: 'system', content: rendererSystemPrompt({ charName, focusCharName: focusName, styleAnchor: styleAnchorFrom(ws, store, session.workId, profile.styleAnchorFrom), guidance, contentTier: profile.contentTier }) },
    { role: 'user', content: `【导演 beat】\n${beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n\n【你的可见世界】\n${contextBrief(visibleState)}${packCtx}\n\n【玩家输入】\n${userMessage}\n\n请渲染本回合正文。` },
  ], { temperature: 0.95, maxTokens: 3000 });
  logUsage(deps, worldId, 'renderer', rendererP, rendererRes.usage);
  const content = rendererRes.content.trim();
  emit({ type: 'content', data: content });

  // ── 3. 文风检测（确定性，零 LLM）──
  const prose = analyzeProse(content);
  emit({ type: 'prose', data: prose });
  if (prose.verdict === 'flat') {
    // 横排重写（MD §3.4 完整版）：多候选并行，检测器选优
    const sys = rendererSystemPrompt({ charName, focusCharName: focusName, styleAnchor: styleAnchorFrom(ws, store, session.workId, profile.styleAnchorFrom), guidance, contentTier: profile.contentTier });
    const { picked, candidates } = await horizontalRewrite(deps, {
      system: sys,
      user: `【上一版被判平淡：${prose.issues.join('；')}】beat 不变，重写正文——句长拉开差距、删掉所有陈词：\n${content}`,
    });
    emit({ type: 'rewrite_candidates', data: candidates.map(c => ({ label: c.label, verdict: c.metrics.verdict, aiCliche: c.metrics.aiClicheDensity })) });
    if (picked && picked.metrics.verdict !== 'flat') {
      emit({ type: 'content', data: picked.text });
      return finishTurn(deps, session, userMessage, picked.text, beat, picked.metrics, emit, options);
    }
  }
  return finishTurn(deps, session, userMessage, content, beat, prose, emit, options);
}

async function finishTurn(deps: EngineDeps, session: ChatSession, userMessage: string, content: string, beat: any, prose: any, emit: Emit, precomputedOptions?: string[]): Promise<TurnResult> {
  const { store, ws } = deps;
  const worldId = session.worldId;
  const extractorP = deps.extractorProvider();
  const stateNow = store.stateAt(worldId);
  const nowT = Number.isFinite(stateNow.asOf.worldTime) ? stateNow.asOf.worldTime : 1000;

  // ── 4. TurnEnd 记账（便宜模型；失败不挡正文，MD MuseAI 原则）──
  let proposalIds: string[] = [];
  let deltas: string[] = [];
  try {
    const extractRes = await callLLM(extractorP, [
      { role: 'system', content: extractorSystemPrompt() + (store.latestPromptOverride(worldId, 'extractor') ? `\n【元层自进化覆盖】\n${store.latestPromptOverride(worldId, 'extractor')}` : '') },
      { role: 'user', content: `【本回合正文】\n${content}\n\n【玩家输入】\n${userMessage}` },
    ], { temperature: 0.1, maxTokens: 1200 });
    logUsage(deps, worldId, 'extractor', extractorP, extractRes.usage);
    const j = extractJson(extractRes.content);
    const events: NewEventInput[] = (j?.events ?? []).map((ev: any) => ({
      worldId, workId: session.workId, actor: 'agent' as const, worldTime: nowT,
      kind: ev.kind, payload: ev.payload, sourceRef: `turn:${session.id}`,
    })).filter((e: NewEventInput) => e.kind);
    if (events.length) {
      const p = await runFunnel(store, worldId, events, deps.adversarialProvider(), `RP 回合 ${session.id}`);
      proposalIds = [p.id];
      deltas = events.map(e => `${e.kind}: ${JSON.stringify(e.payload).slice(0, 60)}`);
      emit({ type: 'proposal', data: { id: p.id, deltas, autoCheck: p.autoCheck, adversarial: p.adversarial } });
    }
  } catch { /* 记账失败不挡正文 */ }

  // ── 5. idle 断言（MD 3.3 主干）：本回合零事实增量 → idle ──
  const idle = proposalIds.length === 0;
  if (idle) emit({ type: 'idle', data: { hint: '本回合无状态变化，下回合导演将强制打破均衡' } });

  const options: string[] = precomputedOptions ?? (Array.isArray(beat.options) ? beat.options.slice(0, 4) : []);
  const costUsd = 0; // 汇总在 usage_log；回合级估算见 session.meta
  session.turns.push({ role: 'user', content: userMessage, at: new Date().toISOString() });
  session.turns.push({ role: 'assistant', content, at: new Date().toISOString(), meta: { idle, beats: beat.beats, prose, options, deltas } });
  ws.saveSession(session);
  emit({ type: 'done', data: { idle, options } });
  return { content, beats: beat.beats, options, idle, proposalIds, prose, costUsd };
}

function thisTurnBrief(store: EventStore, session: ChatSession, userMessage: string): string {
  const recent = session.turns.slice(-8).map(t => `${t.role === 'user' ? '玩家' : '正文'}：${t.content.slice(0, 200)}`).join('\n');
  return `${session.summary ? `【前情提要】\n${session.summary}\n\n` : ''}${recent ? `【近况】\n${recent}\n\n` : ''}【玩家输入】\n${userMessage}`;
}

// ---------- 回合 token 预算 + 95% 强制压缩（MD §6 成本护栏） ----------

import { approxTokens } from '@eventverse/adapters';
export const CONTEXT_BUDGET_TOKENS = Number(process.env.EVENTVERSE_CONTEXT_BUDGET ?? 30000);

/** 纯函数：历史分档（保留最近 keep 轮原文，其余可被摘要替换） */
export function splitHistory(turns: any[], keep = 12): { recent: any[]; older: any[] } {
  return { recent: turns.slice(-keep), older: turns.slice(0, Math.max(0, turns.length - keep)) };
}

/** 纯函数：估算一轮上下文的 token（system + 近史 + 世界简报） */
export function estimateTurnTokens(parts: string[]): number {
  return parts.reduce((a, p) => a + approxTokens(p ?? ''), 0);
}

/** 压缩触发线：估算 ≥ 预算 95% 时先做确定性裁剪（砍最旧原文换摘要） */
export function shouldCompress(parts: string[], budget = CONTEXT_BUDGET_TOKENS): boolean {
  return estimateTurnTokens(parts) >= budget * 0.95;
}

/** 会话级压缩：older 半区 → LLM 前情提要（失败退化为机械截断），并裁剪 turns。
 * 返回是否发生了压缩。幂等：已有摘要时合并旧摘要。 */
export async function compressSession(deps: EngineDeps, session: ChatSession): Promise<boolean> {
  const COMPRESS_AT = 40;
  if (session.turns.length < COMPRESS_AT) return false;
  const { recent, older } = splitHistory(session.turns, Math.floor(session.turns.length / 2));
  const olderText = older.map(t => `${t.role === 'user' ? '玩家' : '正文'}：${t.content}`).join('\n').slice(0, 12000);
  let summary: string;
  try {
    const p = deps.extractorProvider();
    const res = await callLLM(p, [
      { role: 'system', content: '你是剧情压缩器。把给定的对话史压缩为一段 300 字以内的叙事体前情提要：只保留改变了状态的事件、揭示的信息、立下的承诺。直接输出提要正文。' },
      { role: 'user', content: `${session.summary ? `已有前情提要：\n${session.summary}\n\n` : ''}新增对话：\n${olderText}` },
    ], { temperature: 0.2, maxTokens: 600 });
    logUsage(deps, session.worldId, 'compressor', p, res.usage);
    summary = res.content.trim();
    if (!summary || summary.length < 20) throw new Error('empty summary');
  } catch {
    // 机械降级：直接截断拼接，保证回合不因压缩失败而中断
    summary = (session.summary ? session.summary + '\n' : '') + olderText.slice(-600);
  }
  session.summary = summary;
  session.turns = recent;
  session.compressedAt = new Date().toISOString();
  deps.ws.saveSession(session);
  return true;
}

/** 回合前预算门：估算超线 → 先压缩会话，再对世界简报做最简裁剪 */
async function enforceBudget(deps: EngineDeps, session: ChatSession, parts: string[]): Promise<string[]> {
  if (!shouldCompress(parts)) return parts;
  await compressSession(deps, session);
  // 重估：仍超线 → 砍世界简报的一半（确定性，最坏情况保证回合可继续）
  if (shouldCompress(parts)) {
    parts = parts.map(p => (p ?? '').length > 2000 ? (p ?? '').slice(0, Math.floor((p ?? '').length / 2)) : p);
  }
  return parts;
}

function contextBrief(state: any): string {
  const chars = Object.values(state.characters).slice(0, 20).map((c: any) => `${c.name}${c.isDead ? '(已死)' : ''}`).join('、');
  const facts = state.facts.slice(0, 15).map((f: any) => `${f.key}=${f.value}`).join('；');
  const rels = state.relations.slice(0, 15).map((r: any) => {
    const n = (id: string) => state.characters[id]?.name ?? id;
    return `${n(r.from)}-${r.type}-${n(r.to)}`;
  }).join('；');
  return `人物：${chars || '无'}\n设定：${facts || '无'}\n关系：${rels || '无'}`;
}

function logUsage(deps: EngineDeps, worldId: string, role: string, p: ProviderConfig, u: { inputTokens: number; outputTokens: number }) {
  deps.store.logUsage({ worldId, role, model: p.model, inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: estimateCostUsd(p, u.inputTokens, u.outputTokens) });
}

// ---------- 多模型横排重写（MD §3.4 完整版：多候选并行，确定性检测器选优） ----------

export interface RewriteCandidate { label: string; text: string; metrics: ReturnType<typeof analyzeProse> }

export async function horizontalRewrite(
  deps: EngineDeps, base: { system: string; user: string }, count = Number(process.env.EVENTVERSE_REWRITE_CANDIDATES ?? 3),
): Promise<{ picked: RewriteCandidate | null; candidates: RewriteCandidate[] }> {
  const providers = [deps.rendererProvider(), deps.rendererProvider(), deps.adversarialProvider()];
  const temps = [1.05, 1.25, 1.15];
  const jobs = providers.slice(0, Math.max(1, count)).map(async (p, i) => {
    const res = await callLLM(p, [
      { role: 'system', content: base.system },
      { role: 'user', content: base.user },
    ], { temperature: temps[i] ?? 1.1, maxTokens: 3000 });
    logUsage(deps, '', 'rewrite-candidate', p, res.usage);
    return { label: `${p.role}@t${temps[i] ?? 1.1}`, text: res.content.trim(), metrics: analyzeProse(res.content) } as RewriteCandidate;
  });
  const candidates = (await Promise.allSettled(jobs))
    .filter((r): r is PromiseFulfilledResult<RewriteCandidate> => r.status === 'fulfilled')
    .map(r => r.value);
  const score = (c: RewriteCandidate) =>
    (c.metrics.verdict === 'good' ? 3 : c.metrics.verdict === 'ok' ? 1 : 0) * 1000
    + c.metrics.lexicalDiversity * 100 - c.metrics.aiClicheDensity;
  const picked = [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;
  return { picked, candidates };
}

// ---------- in_scene 实装（MD §9 补遗）：从完整状态推导在场者 ----------

/** 在场集合 = 与玩家同位置的角色。秘密事件标 in_scene:auto 时对同场者临时互见。 */
export function presentCharsAt(fullState: any, viewerCharId: string | null): Set<string> {
  const set = new Set<string>();
  if (!viewerCharId) return set;
  const place = fullState?.locations?.[viewerCharId];
  set.add(viewerCharId);
  if (!place) return set;
  for (const [cid, p] of Object.entries(fullState?.locations ?? {})) if (p === place) set.add(cid);
  return set;
}

// ---------- 世界级指标聚合（MD §9.4：千回合 idle 率 / 文风分布） ----------

export interface WorldMetrics {
  turns: number; idleTurns: number; idlePerMill: number;
  prose: { good: number; ok: number; flat: number };
  sessions: number;
}

export function worldMetrics(sessions: any[]): WorldMetrics {
  let turns = 0, idle = 0;
  const prose = { good: 0, ok: 0, flat: 0 };
  for (const s of sessions) {
    for (const t of s.turns ?? []) {
      if (t.role !== 'assistant') continue;
      turns++;
      const m = t.meta ?? {};
      if (m.idle) idle++;
      if (m.prose?.verdict === 'good') prose.good++;
      else if (m.prose?.verdict === 'ok') prose.ok++;
      else if (m.prose?.verdict) prose.flat++;
    }
  }
  return { turns, idleTurns: idle, idlePerMill: turns ? Math.round((idle / turns) * 1000) : 0, prose, sessions: sessions.length };
}

// ---------- 红队泄漏扫描（MD §9.2：可见性过滤层量化，泄漏率应为 0） ----------

export interface RedTeamReport { attempts: number; leaks: number; leakRatePerMill: number; details: string[] }

/** 对每个秘密事实 × 每个非知情角色：stateVisibleTo 是否仍暴露。模型层泄漏无法离线量化，此套覆盖过滤器层。 */
export function redTeamScan(store: EventStore, worldId: string): RedTeamReport {
  const events = store.listEvents(worldId);
  const state = store.stateAt(worldId);
  const chars = Object.keys(state.characters);
  let attempts = 0, leaks = 0;
  const details: string[] = [];
  for (const e of events) {
    if (e.meta || e.supersededBy) continue;
    const v = e.visibility;
    if (v.knowers === '*' || v.inScene === 'auto') continue; // 公开/在场项不测
    const key = (e.payload as any)?.key;
    if (key == null) continue;
    for (const cid of chars) {
      if ((v.knowers as string[]).includes(cid)) continue;
      attempts++;
      const vis = store.stateVisibleTo(worldId, cid);
      const exposed = vis.facts.some(f => f.key === key && f.value === (e.payload as any).value);
      if (exposed) { leaks++; details.push(`${state.characters[cid]?.name} 不应知道 ${key} 却可见`); }
    }
  }
  return { attempts, leaks, leakRatePerMill: attempts ? Math.round((leaks / attempts) * 1000) : 0, details };
}

// ---------- 写作模式（MD 5.2）：大纲 → beat → 草稿 →（作者圈改）→ 定稿同步 ----------

export async function runWriteDraft(deps: EngineDeps, session: ChatSession, outline: string, chapterTitle: string, emit: Emit): Promise<{ draft: string; beats: string[]; prose: any }> {
  const { store, ws } = deps;
  const worldId = session.worldId;
  const guidance = store.listGuidance(worldId).filter(g => g.active).map(g => `${g.title}：${g.description}`);
  const state = store.stateAt(worldId);
  const directorP = deps.directorProvider();
  const dRes = await callLLM(directorP, [
    { role: 'system', content: directorSystemPrompt({ tensionState: tensionBrief(store, worldId), foreshadowPressure: foreshadowPressure(store, worldId), lastTurnIdle: false, guidance }) },
    { role: 'user', content: `写作模式：为以下章节大纲输出 beat 结构（5-9 个）。大纲：\n${outline}` },
  ], { temperature: 0.8, maxTokens: 900 });
  logUsage(deps, worldId, 'director', directorP, dRes.usage);
  const beat = extractJson(dRes.content) ?? { beats: outline.split('\n').filter(Boolean) };
  const beats: string[] = Array.isArray(beat.beats) ? beat.beats : [];
  emit({ type: 'beat', data: { beats } });

  const rendererP = deps.rendererProvider();
  const rRes = await callLLM(rendererP, [
    { role: 'system', content: rendererSystemPrompt({ charName: null, focusCharName: null, styleAnchor: styleAnchorFrom(ws, store, session.workId), guidance }) },
    { role: 'user', content: `为本章写完整正文（2000-4000字）：\n《${chapterTitle}》\n【大纲】\n${outline}\n\n【beat 结构】\n${beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}\n\n【世界上下文】\n${contextBrief(state)}` },
  ], { temperature: 0.95, maxTokens: 6000 });
  logUsage(deps, worldId, 'renderer', rendererP, rRes.usage);
  const prose = analyzeProse(rRes.content);
  emit({ type: 'content', data: rRes.content });
  emit({ type: 'prose', data: prose });
  session.turns.push({ role: 'user', content: `【写作】${chapterTitle}：${outline.slice(0, 200)}`, at: new Date().toISOString() });
  session.turns.push({ role: 'assistant', content: rRes.content, at: new Date().toISOString(), meta: { beats, prose } });
  ws.saveSession(session);
  emit({ type: 'done', data: {} });
  return { draft: rRes.content, beats, prose };
}

/** 圈改重写：局部回炉（写作回路 draft → 作者圈改 → 重写被圈部分） */
export async function rewriteSelection(deps: EngineDeps, session: ChatSession, draft: string, selection: string, instruction: string, emit: Emit): Promise<string> {
  const worldId = session.worldId;
  const guidance = deps.store.listGuidance(worldId).filter(g => g.active).map((g: any) => `${g.title}：${g.description}`);
  const p = deps.rendererProvider();
  const res = await callLLM(p, [
    { role: 'system', content: rendererSystemPrompt({ charName: null, focusCharName: null, guidance, styleAnchor: null }) },
    { role: 'user', content: chatRewritePrompt({ guidance, instruction, draft: selection }) },
  ], { temperature: 0.9, maxTokens: 3000 });
  logUsage(deps, worldId, 'renderer-rewrite', p, res.usage);
  const rewritten = draft.replace(selection, res.content);
  emit({ type: 'content', data: res.content });
  emit({ type: 'done', data: {} });
  return rewritten;
}

/** 定稿：章节落盘 + 手改同步（增量抽取进漏斗，MD 2.3：人写的字优先，AI 只提候选） */
export async function finalizeChapter(deps: EngineDeps, worldId: string, workId: string, chapterId: string, title: string, index: number, worldTime: number, body: string, emit: Emit): Promise<{ proposalIds: string[] }> {
  const { store, ws } = deps;
  ws.writeChapterBody(workId, chapterId, body);
  store.saveChapter({ id: chapterId, workId, title, index, worldTime, kind: 'body', wordCount: body.length });
  store.append({ worldId, workId, worldTime, actor: 'author', kind: 'chapter.anchor', payload: { workId, chapterId, title }, review: { status: 'approved' }, sourceRef: 'finalize' });
  const extractorP = deps.extractorProvider();
  let proposalIds: string[] = [];
  try {
    const res = await callLLM(extractorP, [
      { role: 'system', content: extractorSystemPrompt() },
      { role: 'user', content: body.slice(0, 12000) },
    ], { temperature: 0.1, maxTokens: 2000 });
    logUsage(deps, worldId, 'extractor', extractorP, res.usage);
    const j = extractJson(res.content);
    const events: NewEventInput[] = (j?.events ?? []).map((ev: any) => ({
      worldId, workId, actor: 'agent' as const, worldTime, kind: ev.kind, payload: ev.payload, sourceRef: `finalize:${chapterId}`,
    })).filter((e: NewEventInput) => e.kind);
    if (events.length) {
      const p = await runFunnel(store, worldId, events, deps.adversarialProvider(), `定稿同步 ${title}`);
      proposalIds = [p.id];
      emit({ type: 'proposal', data: { id: p.id, count: events.length } });
    }
  } catch { /* 不挡定稿 */ }
  return { proposalIds };
}

// ---------- 带工具的对话（读侧自由，agent loop ≤12 次，MD 3.1） ----------

export async function runToolChat(deps: EngineDeps, ctx: ToolContext, messages: Array<{ role: string; content: string }>, emit: Emit): Promise<{ content: string; toolCalls: string[] }> {
  const chatP = deps.rendererProvider();
  // 基准驱动：可见状态每回合预算一次，工具循环内复用（stateVisibleTo 全量重放 600ms+/次）
  if (ctx.viewerCharId && !ctx.viewerState) {
    ctx.viewerState = ctx.store.stateVisibleTo(ctx.worldId, ctx.viewerCharId);
  }
  const msgs: any[] = [...messages];
  const used: string[] = [];
  for (let round = 0; round < MAX_AGENT_TOOL_CALLS; round++) {
    const res = await callLLM(chatP, msgs, { tools: toolSpecs(), temperature: 0.7, maxTokens: 2000 });
    logUsage(deps, ctx.worldId, 'toolchat', chatP, res.usage);
    if (!res.toolCalls.length) {
      // 兜底：部分推理模型经工具循环后 content 为空 → 追加一次"直接作答"调用
      let content = res.content;
      if (!content.trim() && used.length) {
        msgs.push({ role: 'user', content: '请基于以上工具查询结果直接回答用户的最新问题，不要再说需要查询。' });
        const r2 = await callLLM(chatP, msgs, { temperature: 0.5, maxTokens: 1500 });
        logUsage(deps, ctx.worldId, 'toolchat-final', chatP, r2.usage);
        content = r2.content || content;
      }
      emit({ type: 'content', data: content });
      emit({ type: 'done', data: { toolCalls: used } });
      return { content, toolCalls: used };
    }
    msgs.push({ role: 'assistant', content: res.content, tool_calls: res.toolCalls });
    for (const tc of res.toolCalls) {
      used.push(tc.name);
      emit({ type: 'tool', data: { name: tc.name, args: tc.arguments } });
      let result: string;
      try {
        const args = extractJson(tc.arguments) ?? {};
        result = await executeTool(ctx, tc.name, args);
      } catch (e: any) {
        result = `工具执行失败：${e?.message ?? e}`;
      }
      emit({ type: 'tool_result', data: { name: tc.name, preview: result.slice(0, 200) } });
      msgs.push({ role: 'tool', content: result, toolCallId: tc.id, name: tc.name });
    }
  }
  const fallback = '（工具预算用尽）';
  emit({ type: 'done', data: { toolCalls: used, budgetExhausted: true } });
  return { content: fallback, toolCalls: used };
}
