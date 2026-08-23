// 纯函数 reducer：状态重放（MD 1.2 一个机制四个视图 / Rust 移植边界内的代码）
import { WorldEvent, WorldState, emptyState } from './types.js';

/** 按事件应用（纯函数，不改入参）。meta 事件与被推翻事件不参与。 */
export function applyEvent(state: WorldState, e: WorldEvent): WorldState {
  if (e.meta || e.supersededBy) return state;
  const s: WorldState = { ...state, characters: { ...state.characters }, locations: { ...state.locations }, items: { ...state.items } };
  const p = e.payload as any;
  switch (e.kind) {
    case 'char.create':
      s.characters[p.id] = { id: p.id, name: p.name, aliases: p.aliases ?? [], gender: p.gender, attrs: p.attrs ?? {}, isDead: false };
      break;
    case 'char.update': {
      const c = s.characters[p.id];
      if (c) s.characters[p.id] = {
        ...c, name: p.patch.name ?? c.name,
        aliases: p.patch.aliases ?? c.aliases,
        attrs: { ...c.attrs, ...(p.patch.attrs ?? {}) },
      };
      break;
    }
    case 'char.death':
      if (s.characters[p.id]) s.characters[p.id] = { ...s.characters[p.id], isDead: true, diedAt: e.worldTime };
      break;
    case 'char.revive':
      if (s.characters[p.id]) s.characters[p.id] = { ...s.characters[p.id], isDead: false, diedAt: undefined };
      break;
    case 'relation.set': {
      s.relations = s.relations.filter(r => r.id !== p.id);
      s.relations = [...s.relations, { id: p.id, from: p.from, to: p.to, type: p.type, validFrom: p.validFrom, validTo: p.validTo ?? null, note: p.note }];
      break;
    }
    case 'relation.end':
      s.relations = s.relations.map(r => r.id === p.id ? { ...r, validTo: Math.min(r.validTo ?? Infinity, p.validTo) } : r);
      break;
    case 'fact.set': {
      // 同 key 旧区间自动关闭（事实修正链）
      s.facts = s.facts.map(f => f.key === p.key && f.validTo === null ? { ...f, validTo: p.validFrom } : f);
      s.facts = [...s.facts, { key: p.key, value: p.value, validFrom: p.validFrom, validTo: p.validTo ?? null }];
      break;
    }
    case 'location.move':
      s.locations[p.charId] = p.place;
      break;
    case 'item.create':
      s.items[p.id] = { id: p.id, name: p.name, holder: p.holder };
      break;
    case 'item.transfer':
      if (s.items[p.id]) s.items[p.id] = { ...s.items[p.id], holder: p.holder };
      break;
    case 'foreshadow.plant':
      s.foreshadowings = [...s.foreshadowings.filter(f => f.id !== p.id),
        { id: p.id, description: p.description, plantedAt: e.worldTime, deadlineWorldTime: p.deadlineWorldTime ?? null, recoveredAt: null }];
      break;
    case 'foreshadow.recover':
      s.foreshadowings = s.foreshadowings.map(f => f.id === p.id ? { ...f, recoveredAt: e.worldTime } : f);
      break;
    case 'intent.set':
      s.intents = [...s.intents, { description: p.description, priority: p.priority ?? 0, setAt: e.worldTime }];
      break;
    // chapter.anchor / meta.* 不改状态
  }
  s.asOf = { sequence: e.sequence, worldTime: e.worldTime };
  return s;
}

/** 按世界时间序（次按 sequence）重放到 t（含），再过滤区间事实到 t 时刻有效 */
export function replay(events: WorldEvent[], worldId: string, upto?: { worldTime?: number; sequence?: number }): WorldState {
  let list = events.filter(e => e.worldId === worldId && !e.meta && !e.supersededBy);
  if (upto?.sequence != null) list = list.filter(e => e.sequence <= upto.sequence!);
  if (upto?.worldTime != null) list = list.filter(e => e.worldTime <= upto.worldTime!);
  list = [...list].sort((a, b) => a.worldTime - b.worldTime || a.sequence - b.sequence);
  let s = emptyState(worldId);
  for (const e of list) s = applyEvent(s, e);
  const t = upto?.worldTime ?? (list.length ? list[list.length - 1].worldTime : Infinity);
  // 区间过滤：killer 时间轴语义——t 时刻为真的关系/事实
  s.relations = s.relations.filter(r => r.validFrom <= t && (r.validTo == null || r.validTo > t));
  s.facts = s.facts.filter(f => f.validFrom <= t && (f.validTo == null || f.validTo > t));
  // 未回收且过期的伏笔标记（deadline 用于导演压力注入）
  s.foreshadowings = s.foreshadowings.map(f =>
    f.recoveredAt == null && f.deadlineWorldTime != null && f.deadlineWorldTime < t ? { ...f, deadlineWorldTime: f.deadlineWorldTime } : f);
  return s;
}

/** 可见性过滤：只重放对 viewer 可见的事件（recall 工具的服务端实现） */
export function replayVisible(events: WorldEvent[], worldId: string, viewerCharId: string, upto?: { worldTime?: number }): WorldState {
  const visible = events.filter(e => {
    if (e.worldId !== worldId) return false;
    const v = e.visibility;
    if (v.knowers === '*') return true;
    if (v.knowers.includes(viewerCharId)) {
      if (v.sinceEvent && e.sequence < v.sinceEvent) return false;
      return true;
    }
    return false;
  });
  return replay(visible, worldId, upto);
}

/** 两个状态的差异（diff 视图） */
export interface StateDiff {
  characters: Array<{ id: string; before?: any; after?: any; change: string }>;
  relations: Array<{ id: string; change: 'add' | 'remove' | 'change'; before?: any; after?: any }>;
  facts: Array<{ key: string; change: 'add' | 'remove' | 'change'; before?: string; after?: string }>;
  locations: Array<{ charId: string; before?: string; after?: string }>;
  foreshadowings: Array<{ id: string; change: 'planted' | 'recovered' }>;
}

export function diffStates(a: WorldState, b: WorldState): StateDiff {
  const d: StateDiff = { characters: [], relations: [], facts: [], locations: [], foreshadowings: [] };
  const ids = new Set([...Object.keys(a.characters), ...Object.keys(b.characters)]);
  for (const id of ids) {
    const x = a.characters[id], y = b.characters[id];
    if (!x && y) d.characters.push({ id, after: y, change: 'create' });
    else if (x && !y) d.characters.push({ id, before: x, change: 'delete' });
    else if (x && y && JSON.stringify(x) !== JSON.stringify(y)) {
      const changes: string[] = [];
      if (x.name !== y.name) changes.push('name');
      if (x.isDead !== y.isDead) changes.push(y.isDead ? 'death' : 'revive');
      if (JSON.stringify(x.aliases) !== JSON.stringify(y.aliases)) changes.push('aliases');
      if (JSON.stringify(x.attrs) !== JSON.stringify(y.attrs)) changes.push('attrs');
      d.characters.push({ id, before: x, after: y, change: changes.join(',') });
    }
  }
  const rmap = new Map<string, any>();
  for (const r of [...a.relations, ...b.relations]) rmap.set(r.id + '|' + r.from + '|' + r.to + '|' + r.type + '|' + r.validFrom, r);
  const ra = new Set(a.relations.map(r => r.id + '|' + r.from + '|' + r.to + '|' + r.type + '|' + r.validFrom));
  const rb = new Set(b.relations.map(r => r.id + '|' + r.from + '|' + r.to + '|' + r.type + '|' + r.validFrom));
  for (const k of ra) if (!rb.has(k)) d.relations.push({ id: k, before: rmap.get(k), change: 'remove' });
  for (const k of rb) if (!ra.has(k)) d.relations.push({ id: k, after: rmap.get(k), change: 'add' });
  const fkeys = new Set([...a.facts.map(f => f.key + '|' + f.validFrom), ...b.facts.map(f => f.key + '|' + f.validFrom)]);
  const fa = new Map(a.facts.map(f => [f.key + '|' + f.validFrom, f]));
  const fb = new Map(b.facts.map(f => [f.key + '|' + f.validFrom, f]));
  for (const k of fkeys) {
    const x = fa.get(k), y = fb.get(k);
    if (x && !y) d.facts.push({ key: x.key, before: x.value, change: 'remove' });
    if (!x && y) d.facts.push({ key: y.key, after: y.value, change: 'add' });
  }
  for (const cid of new Set([...Object.keys(a.locations), ...Object.keys(b.locations)])) {
    if (a.locations[cid] !== b.locations[cid])
      d.locations.push({ charId: cid, before: a.locations[cid], after: b.locations[cid] });
  }
  const pa = new Set(a.foreshadowings.filter(f => f.recoveredAt == null).map(f => f.id));
  const pb = new Set(b.foreshadowings.filter(f => f.recoveredAt == null).map(f => f.id));
  for (const id of pb) if (!pa.has(id)) d.foreshadowings.push({ id, change: 'planted' });
  for (const id of pa) if (!pb.has(id)) d.foreshadowings.push({ id, change: 'recovered' });
  return d;
}

export function isEmptyDiff(d: StateDiff): boolean {
  return d.characters.length + d.relations.length + d.facts.length + d.locations.length + d.foreshadowings.length === 0;
}
