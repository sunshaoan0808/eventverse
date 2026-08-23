import { describe, it, expect, beforeEach } from 'vitest';
import { EventStore } from './store.js';
import { replay, diffStates, isEmptyDiff, replayVisible } from './reducer.js';
import { WorldEvent, emptyState } from './types.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let store: EventStore;
beforeEach(() => {
  store = new EventStore(join(tmpdir(), `ev-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  store.createWorld('w1', '测试世界');
});

describe('M0 事件库与重放', () => {
  it('append 分配单调 sequence', () => {
    const a = store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1010, payload: { id: 'A', name: '林澜' } });
    const b = store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1010, payload: { id: 'B', name: '沈青' } });
    expect(b.sequence).toBe(a.sequence + 1);
  });

  it('状态重放：时间轴四视图之 [时间轴]', () => {
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1010, payload: { id: 'A', name: '林澜' } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1010, payload: { id: 'B', name: '沈青' } });
    // 1012 两人恋人，1016 分手
    store.append({ worldId: 'w1', actor: 'author', kind: 'relation.set', worldTime: 1012, payload: { id: 'r1', from: 'A', to: 'B', type: '恋人', validFrom: 1012 } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'relation.end', worldTime: 1016, payload: { id: 'r1', validTo: 1016 } });

    const at1013 = store.stateAt('w1', { worldTime: 1013 });
    expect(at1013.relations.length).toBe(1);
    expect(at1013.relations[0].type).toBe('恋人');

    const at1020 = store.stateAt('w1', { worldTime: 1020 });
    expect(at1020.relations.length).toBe(0); // killer 时间轴：拖到 1020 年关系已结束
  });

  it('状态重放：死亡与区间事实', () => {
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1000, payload: { id: 'C', name: '老者' } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.death', worldTime: 1005, payload: { id: 'C' } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'fact.set', worldTime: 1001, payload: { key: 'setting:王朝', value: '景朝', validFrom: 1001 } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'fact.set', worldTime: 1010, payload: { key: 'setting:王朝', value: '新朝', validFrom: 1010 } });

    const at1003 = store.stateAt('w1', { worldTime: 1003 });
    expect(at1003.characters.C.isDead).toBe(false);
    expect(at1003.facts.find(f => f.key === 'setting:王朝')?.value).toBe('景朝');

    const at1012 = store.stateAt('w1', { worldTime: 1012 });
    expect(at1012.characters.C.isDead).toBe(true);
    expect(at1012.facts.find(f => f.key === 'setting:王朝')?.value).toBe('新朝');
  });

  it('[diff 视图] 两时刻差异', () => {
    const a = store.stateAt('w1', { worldTime: 1013 });
    const b = store.stateAt('w1', { worldTime: 1017 });
    // no events yet -> empty diff
    expect(isEmptyDiff(diffStates(a, b))).toBe(true);
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1010, payload: { id: 'A', name: 'A' } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'location.move', worldTime: 1015, payload: { charId: 'A', place: '北境' } });
    const d = store.diff('w1', { worldTime: 1013 }, { worldTime: 1017 });
    expect(d.locations.length).toBe(1);
    expect(d.locations[0].after).toBe('北境');
  });

  it('[回滚] 被推翻事件不参与重放，且不物理删除', () => {
    const e = store.append({ worldId: 'w1', actor: 'agent', kind: 'fact.set', worldTime: 1001, payload: { key: 'setting:首都', value: '误录', validFrom: 1001 } });
    store.rollback(e.id, '误录');
    const s = store.stateAt('w1');
    expect(s.facts.find(f => f.key === 'setting:首都')).toBeUndefined();
    const raw = store.listEvents('w1');
    expect(raw.find(x => x.id === e.id)).toBeDefined(); // 审计保留
    expect(raw.find(x => x.id === e.id)!.supersededBy).toBeTruthy();
  });

  it('[世界线分支] branch 复制到指定 sequence', () => {
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1010, payload: { id: 'A', name: 'A' } });
    const e2 = store.append({ worldId: 'w1', actor: 'author', kind: 'fact.set', worldTime: 1011, payload: { key: 'k', value: 'v1', validFrom: 1011 } });
    const e3 = store.append({ worldId: 'w1', actor: 'author', kind: 'fact.set', worldTime: 1012, payload: { key: 'k', value: 'v2', validFrom: 1012 } });
    const { copied } = store.branchWorld('w1', 'w1-branch', '分支线', e2.sequence);
    expect(copied).toBe(2);
    const bs = store.stateAt('w1-branch');
    expect(bs.facts.find(f => f.key === 'k')?.value).toBe('v1');
  });

  it('[可见性] recall 只看到知情范围内的事件', () => {
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1000, payload: { id: 'A', name: 'A' } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1000, payload: { id: 'B', name: 'B' } });
    // A 的秘密：只有 A 知道
    store.append({ worldId: 'w1', actor: 'author', kind: 'fact.set', worldTime: 1001, payload: { key: 'secret:A身世', value: '前朝遗孤', validFrom: 1001 }, visibility: { knowers: ['A'], scope: 'secret' } });
    const forA = store.stateVisibleTo('w1', 'A');
    const forB = store.stateVisibleTo('w1', 'B');
    expect(forA.facts.find(f => f.key === 'secret:A身世')).toBeDefined();
    expect(forB.facts.find(f => f.key === 'secret:A身世')).toBeUndefined(); // 防全知泄漏
  });

  it('proposal 漏斗：approve 后才落库', () => {
    const pid = 'p1';
    store.saveProposal({
      id: pid, worldId: 'w1',
      events: [{ worldId: 'w1', workId: null, worldTime: 1002, actor: 'agent', kind: 'fact.set', payload: { key: 'g', value: '1', validFrom: 1002 }, visibility: { knowers: '*', scope: 'public' }, review: { status: 'pending' }, supersededBy: null, createdAt: '' } as any],
      autoCheck: { ok: true, issues: [] }, adversarial: { verdict: 'normal' }, status: 'pending', createdAt: new Date().toISOString(), sourceLabel: 'test',
    });
    expect(store.stateAt('w1').facts.length).toBe(0);
    store.setProposalStatus(pid, 'approved');
    const applied = store.applyProposal(pid);
    expect(applied.length).toBe(1);
    expect(store.stateAt('w1').facts.length).toBe(1);
  });

  it('guidance 与用量记录', () => {
    store.addGuidance({ title: '文风', description: '冷峻短句', source: 'author', active: true, worldId: 'w1' } as any);
    expect(store.listGuidance('w1').length).toBe(1);
    store.logUsage({ worldId: 'w1', role: 'renderer', model: 'test', inputTokens: 10, outputTokens: 5 });
    expect((store.usageReport('w1') as any[]).length).toBe(1);
  });
});
