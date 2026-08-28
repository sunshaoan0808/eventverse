// 工具面（MD 3.1）：五个只读 + 唯一写入口 propose。agent 在读侧自由、写侧走漏斗。
import { EventStore, WorldState, NewEventInput } from '@eventverse/core';
import { ToolSpec } from '@eventverse/adapters';
import { Workspace } from './workspace.js';
import { runFunnel } from './funnel.js';
import { ProviderConfig } from '@eventverse/adapters';

export interface ToolContext {
  store: EventStore;
  ws: Workspace;
  worldId: string;
  workId: string | null;
  /** 可见性视角（RP 模式下为玩家角色） */
  viewerCharId: string | null;
  /** ★每回合预算一次的可见状态（基准驱动：stateVisibleTo 全量重放 600ms+/次，工具内复用） */
  viewerState?: WorldState;
  adversarialProvider: ProviderConfig;
  sourceLabel: string;
}

export const MAX_AGENT_TOOL_CALLS = 12;

export function toolSpecs(): ToolSpec[] {
  return [
    { type: 'function', function: { name: 'story_index', description: '列出作品的卷章结构与每章概要', parameters: { type: 'object', properties: { offset: { type: 'number' }, limit: { type: 'number' } } } } },
    { type: 'function', function: { name: 'read_chapters', description: '读取指定章节正文（一次最多 3 章）', parameters: { type: 'object', properties: { chapterIds: { type: 'array', items: { type: 'string' } } }, required: ['chapterIds'] } } },
    { type: 'function', function: { name: 'grep', description: '正文关键词检索，返回命中的章节与片段', parameters: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'number' } }, required: ['keyword'] } } },
    { type: 'function', function: { name: 'search_entities', description: '检索设定/人物/关系/时间线/伏笔等结构化实体', parameters: { type: 'object', properties: { query: { type: 'string' }, categories: { type: 'array', items: { type: 'string' } } }, required: ['query'] } } },
    { type: 'function', function: { name: 'recall', description: '以当前角色视角查询世界状态（自动按可见性过滤，防全知）', parameters: { type: 'object', properties: { about: { type: 'string', description: '想了解什么：self / relations / scene / world' } } } } },
    { type: 'function', function: { name: 'propose', description: '提出对世界状态的修改（唯一写入口，进入审核漏斗，不直接生效）', parameters: { type: 'object', properties: { reason: { type: 'string' }, events: { type: 'array', items: { type: 'object' } } }, required: ['events'] } } },
  ];
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + `…(截断，共${s.length}字)` : s;
}

export async function executeTool(ctx: ToolContext, name: string, args: any): Promise<string> {
  const { store, ws, worldId, workId } = ctx;
  switch (name) {
    case 'story_index': {
      const workIds = workId ? [workId] : store.listWorks(worldId).map(w => w.id);
      const out: string[] = [];
      for (const wid of workIds) {
        const w = store.getWork(wid);
        out.push(`《${w?.title ?? wid}》`);
        for (const c of store.listChapters(wid)) {
          const body = ws.readChapterBody(wid, c.id) ?? '';
          out.push(`  [${c.id}] 第${c.index + 1}章 ${c.title}（t=${c.worldTime}，${body.length}字）：${body.slice(0, 80).replace(/\n/g, ' ')}…`);
        }
      }
      return truncate(out.join('\n'));
    }
    case 'read_chapters': {
      const ids: string[] = (args.chapterIds ?? []).slice(0, 3);
      const out: string[] = [];
      for (const id of ids) {
        const c = store.getChapter(id);
        if (!c) { out.push(`[${id}] 不存在`); continue; }
        out.push(`[${id}] ${c.title}（t=${c.worldTime}）\n${ws.readChapterBody(c.workId, id) ?? ''}`);
      }
      return truncate(out.join('\n\n'));
    }
    case 'grep': {
      const kw = String(args.keyword ?? '');
      const limit = args.limit ?? 8;
      const hits: string[] = [];
      for (const w of store.listWorks(worldId)) {
        for (const c of store.listChapters(w.id)) {
          const body = ws.readChapterBody(w.id, c.id);
          if (!body) continue;
          const idx = body.indexOf(kw);
          if (idx >= 0) {
            hits.push(`[${c.id}] ${c.title}：…${body.slice(Math.max(0, idx - 40), idx + 60).replace(/\n/g, ' ')}…`);
            if (hits.length >= limit) return truncate(hits.join('\n'));
          }
        }
      }
      return hits.length ? truncate(hits.join('\n')) : `未命中 "${kw}"`;
    }
    case 'search_entities': {
      const q = String(args.query ?? '');
      const state = ctx.viewerState ?? (ctx.viewerCharId ? store.stateVisibleTo(worldId, ctx.viewerCharId) : store.stateAt(worldId));
      const hits: string[] = [];
      for (const c of Object.values(state.characters)) {
        if (c.name.includes(q) || c.id.includes(q) || c.aliases.some(a => a.includes(q)))
          hits.push(`人物 ${c.name}(${c.id})${c.isDead ? '【已死】' : ''} 属性:${JSON.stringify(c.attrs)}`);
      }
      const nameOf = (id: string) => state.characters[id]?.name ?? id;
      for (const r of state.relations) {
        if (r.type.includes(q) || nameOf(r.from).includes(q) || nameOf(r.to).includes(q))
          hits.push(`关系 ${nameOf(r.from)} —${r.type}→ ${nameOf(r.to)}（${r.validFrom}~${r.validTo ?? '今'}）`);
      }
      for (const f of state.facts) {
        if (f.key.includes(q) || f.value.includes(q)) hits.push(`设定 ${f.key} = ${f.value}`);
      }
      for (const f of state.foreshadowings.filter(f => f.recoveredAt == null)) {
        if (f.description.includes(q)) hits.push(`未回收伏笔：${f.description}`);
      }
      for (const [cid, place] of Object.entries(state.locations)) {
        if (place.includes(q) || nameOf(cid).includes(q)) hits.push(`位置 ${nameOf(cid)} @ ${place}`);
      }
      return hits.length ? truncate(hits.slice(0, 30).join('\n')) : `未命中 "${q}"`;
    }
    case 'recall': {
      if (!ctx.viewerCharId) return 'recall 需要 RP 会话（无玩家角色视角）';
      const state = ctx.viewerState ?? store.stateVisibleTo(worldId, ctx.viewerCharId);
      const about = String(args.about ?? 'self');
      const nameOf = (id: string) => state.characters[id]?.name ?? id;
      if (about.includes('self')) {
        const me = state.characters[ctx.viewerCharId];
        return me ? truncate(JSON.stringify(me)) : '你在这个世界还没有登记的身份';
      }
      if (about.includes('relation')) {
        return truncate(state.relations.filter(r => r.from === ctx.viewerCharId || r.to === ctx.viewerCharId)
          .map(r => `${nameOf(r.from)} —${r.type}→ ${nameOf(r.to)}`).join('\n') || '无已知关系');
      }
      if (about.includes('scene')) {
        return truncate(Object.entries(state.locations).map(([cid, p]) => `${nameOf(cid)} @ ${p}`).join('\n') || '无位置信息');
      }
      return truncate(`世界设定：\n${state.facts.map(f => `${f.key}=${f.value}`).join('\n') || '无'}\n在册人物：${Object.values(state.characters).map(c => c.name + (c.isDead ? '(已死)' : '')).join('、')}`);
    }
    case 'propose': {
      const events: any[] = args.events ?? [];
      const inputs: NewEventInput[] = events.map(e => ({
        worldId, workId, actor: 'agent' as const,
        worldTime: e.worldTime ?? store.stateAt(worldId).asOf.worldTime,
        kind: e.kind, payload: e.payload,
        visibility: e.visibility, sourceRef: ctx.sourceLabel,
      })).filter(i => i.kind);
      if (!inputs.length) return '无有效事件';
      const p = await runFunnel(store, worldId, inputs, ctx.adversarialProvider, ctx.sourceLabel);
      return `提案 ${p.id} 已入审核队列（自动校验：${p.autoCheck.ok ? '通过' : '有问题 ' + p.autoCheck.issues.join(';')}；对抗审：${p.adversarial?.verdict ?? '未跑'}）。等待人工批准后生效。`;
    }
    default:
      return `未知工具 ${name}`;
  }
}
