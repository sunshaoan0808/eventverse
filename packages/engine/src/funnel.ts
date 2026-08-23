// 对抗审漏斗（MD 2.2）：①自动校验（确定性）→ ②对抗审（LLM/启发式）→ ③人工审
// 轻事实模式（MD 5.3）：按事件量分级
import { EventStore, WorldEvent, Proposal, NewEventInput } from '@eventverse/core';
import { callLLM, extractJson, ProviderConfig } from '@eventverse/adapters';
import { adversarialSystemPrompt } from './prompts.js';
import { randomUUID } from 'node:crypto';

export const HIGH_IMPACT_KINDS = new Set(['relation.set', 'char.death', 'char.revive']);

/** 引用归一化：人名→角色 id；同名 char.create 合并为 char.update（Scriverse create/merge 思路） */
export function normalizeRefs(store: EventStore, worldId: string, rawInputs: NewEventInput[]): { events: NewEventInput[]; notes: string[] } {
  const state = store.stateAt(worldId);
  const nameToId = new Map<string, string>();
  for (const c of Object.values(state.characters)) {
    nameToId.set(c.name, c.id);
    for (const a of c.aliases) nameToId.set(a, c.id);
  }
  const notes: string[] = [];
  // 批次内预注册：本批新建的角色名也可被同批事件引用
  for (const i of rawInputs) {
    if (i.kind === 'char.create' && i.payload?.name && !nameToId.has(i.payload.name)) {
      nameToId.set(i.payload.name, i.payload.id ?? i.payload.name);
    }
  }
  const out: NewEventInput[] = [];
  for (const i of rawInputs) {
    const p: any = { ...i.payload };
    switch (i.kind) {
      case 'char.create': {
        const existing = nameToId.get(p.name) ?? (state.characters[p.id] ? p.id : undefined);
        if (existing && state.characters[existing]) {
          // 同名/同 id 已存在 → 合并为属性更新，不造重复角色
          if (p.attrs && Object.keys(p.attrs).length) {
            out.push({ ...i, kind: 'char.update', payload: { id: existing, patch: { attrs: p.attrs } } });
            notes.push(`角色「${p.name}」已存在，合并为属性更新`);
          } else {
            notes.push(`角色「${p.name}」已存在，跳过`);
          }
        } else {
          if (p.id && nameToId.has(p.id)) p.id = p.name; // id 撞了别人的名字
          out.push({ ...i, payload: p });
        }
        break;
      }
      case 'char.death':
      case 'char.update':
        p.id = nameToId.get(p.id) ?? (state.characters[p.id] ? p.id : p.id);
        out.push({ ...i, payload: p });
        break;
      case 'relation.set':
        p.from = nameToId.get(p.from) ?? p.from;
        p.to = nameToId.get(p.to) ?? p.to;
        out.push({ ...i, payload: p });
        break;
      case 'location.move':
        p.charId = nameToId.get(p.charId) ?? p.charId;
        out.push({ ...i, payload: p });
        break;
      case 'item.transfer':
        p.holder = nameToId.get(p.holder) ?? p.holder;
        out.push({ ...i, payload: p });
        break;
      default:
        out.push({ ...i, payload: p });
    }
  }
  return { events: out, notes };
}

/** ① 自动校验：schema/引用完整性/时间悖论（确定性代码，零 LLM） */
export function autoValidate(store: EventStore, worldId: string, inputs: NewEventInput[]): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const state = store.stateAt(worldId);
  const knownChars = new Set(Object.keys(state.characters));
  const futureNames = new Set<string>();
  for (const i of inputs) {
    if (i.kind === 'char.create') futureNames.add(i.payload.name);
  }
  const nameToId = new Map(Object.values(state.characters).map(c => [c.name, c.id]));
  for (const i of inputs) {
    const p: any = i.payload;
    switch (i.kind) {
      case 'char.create':
        if (!p.id || !p.name) issues.push('char.create 缺 id/name');
        break;
      case 'relation.set':
        for (const side of ['from', 'to']) {
          const v = p[side];
          if (!knownChars.has(v) && !futureNames.has(v)) issues.push(`relation.set 引用未知角色 "${v}"`);
        }
        if (p.validFrom == null) issues.push('relation.set 缺 validFrom');
        if (p.validTo != null && p.validTo < p.validFrom) issues.push('relation.set validTo < validFrom');
        break;
      case 'char.death':
      case 'char.update': {
        const target = nameToId.get(p.id) ?? p.id;
        if (!knownChars.has(target) && !futureNames.has(p.id)) issues.push(`${i.kind} 引用未知角色 "${p.id}"`);
        break;
      }
      case 'location.move':
        if (!knownChars.has(nameToId.get(p.charId) ?? p.charId) && !futureNames.has(p.charId)) issues.push(`location.move 引用未知角色 "${p.charId}"`);
        break;
      case 'fact.set':
        if (!p.key || p.value == null) issues.push('fact.set 缺 key/value');
        break;
      default: break;
    }
    // 时间悖论：事件世界时间早于角色死亡时间且涉及该角色行动
    if (i.kind === 'location.move' || i.kind === 'relation.set') {
      const charIds = [nameToId.get(p.charId ?? p.from) ?? p.charId ?? p.from];
      for (const cid of charIds) {
        const c = state.characters[cid];
        if (c?.isDead && c.diedAt != null && i.worldTime > c.diedAt) issues.push(`时间悖论：${c.name} 已于 ${c.diedAt} 死亡，却在 ${i.worldTime} 行动`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

/** ② 对抗审：有 LLM 用 LLM，无 LLM（mock/未配置）退化为启发式 */
export async function adversarialReview(
  store: EventStore, worldId: string, inputs: NewEventInput[],
  provider: ProviderConfig,
): Promise<{ verdict: 'normal' | 'conflict' | 'high_impact'; reason?: string }> {
  const state = store.stateAt(worldId);
  const related: string[] = [];
  for (const i of inputs) {
    const p: any = i.payload;
    const names = [p.from, p.to, p.charId, p.id].filter((x: any) => typeof x === 'string');
    for (const c of Object.values(state.characters)) {
      if (names.includes(c.name) || names.includes(c.id)) {
        if (c.isDead) related.push(`${c.name} 已死亡`);
      }
    }
  }
  // LLM 对抗审
  const desc = inputs.map(i => `[${i.kind}] ${JSON.stringify(i.payload)} @t=${i.worldTime}`).join('\n');
  try {
    const res = await callLLM(provider, [
      { role: 'system', content: adversarialSystemPrompt() },
      { role: 'user', content: `候选事实：\n${desc}\n\n既有状态摘要：${JSON.stringify({ chars: Object.values(state.characters).map(c => `${c.name}${c.isDead ? '(已死)' : ''}`), relations: state.relations.map(r => `${r.from}-${r.type}-${r.to}`) })}\n\n${related.length ? '已知疑点：' + related.join('；') : ''}` },
    ], { temperature: 0.1, maxTokens: 300 });
    const j = extractJson(res.content);
    if (j?.verdict) return { verdict: j.verdict, reason: j.reason };
  } catch { /* 退化为启发式 */ }
  // 启发式退化：死者在场→conflict；高危 kind→high_impact
  if (related.length) return { verdict: 'conflict', reason: related.join('；') };
  if (inputs.some(i => HIGH_IMPACT_KINDS.has(i.kind))) return { verdict: 'high_impact', reason: '高危类型（关系/生死）' };
  return { verdict: 'normal' };
}

/** 轻事实模式分级（MD 5.3） */
export function funnelModeFor(store: EventStore, worldId: string): 'light' | 'semi' | 'full' {
  const count = store.listEvents(worldId).filter(e => !e.meta).length;
  if (count < 500) return 'light';
  if (count < 5000) return 'semi';
  return 'full';
}

/**
 * 完整漏斗：候选 → proposal。
 * light：自动校验通过即 auto_ok 直接可批（不跑对抗审）
 * semi：仅高危 kind 跑对抗审
 * full：全部跑
 */
export async function runFunnel(
  store: EventStore, worldId: string, rawInputs: NewEventInput[],
  adversarialProvider: ProviderConfig, sourceLabel: string,
): Promise<Proposal> {
  const { events: inputs, notes } = normalizeRefs(store, worldId, rawInputs);
  const autoCheck = autoValidate(store, worldId, inputs);
  if (notes.length) autoCheck.issues.push(...notes.map(n => `[归一化] ${n}`));
  const mode = funnelModeFor(store, worldId);
  let adversarial: Proposal['adversarial'] = null;
  if (autoCheck.ok) {
    if (mode === 'full' || (mode === 'semi' && inputs.some(i => HIGH_IMPACT_KINDS.has(i.kind)))) {
      adversarial = await adversarialReview(store, worldId, inputs, adversarialProvider);
    } else {
      adversarial = { verdict: 'normal', reason: `轻事实模式(${mode})跳过对抗审` };
    }
  }
  // 状态：对抗审 normal 且自动校验过 → 视为 auto_ok（可直接自动应用或一键批）
  // 乐观锁基线：记录创建时的世界版本（批准时校验是否已被并发推进，MD 2.2 expectedVersionNo 思路）
  const baseSeq = (store.db.prepare('SELECT MAX(sequence) AS m FROM events WHERE world_id=?').get(worldId) as any)?.m ?? 0;
  const status: Proposal['status'] = 'pending';
  const proposal: Proposal = {
    id: `prop-${randomUUID().slice(0, 10)}`, worldId, baseSeq,
    events: inputs.map(i => ({
      worldId: i.worldId, workId: i.workId ?? null, worldTime: i.worldTime, worldTimeLabel: i.worldTimeLabel,
      actor: i.actor, kind: i.kind, payload: i.payload, visibility: i.visibility ?? { knowers: '*', scope: 'public' },
      review: { status: 'pending' }, supersededBy: null, sourceRef: i.sourceRef ?? null, meta: i.meta,
    })) as any,
    autoCheck, adversarial, status, createdAt: new Date().toISOString(), sourceLabel,
  };
  store.saveProposal(proposal);
  return proposal;
}
