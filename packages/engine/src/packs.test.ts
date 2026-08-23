import { describe, it, expect, beforeEach } from 'vitest';
import { EventStore, NewEventInput } from '@eventverse/core';
import { Workspace, PackStore, packPlayable, StoryPack, importNovel, JobRegistry, autoValidate, runFunnel } from './index.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

let store: EventStore;
let ws: Workspace;
let packs: PackStore;
let jobs: JobRegistry;
const mockP = (role: any) => ({ id: `m-${role}`, protocol: 'mock' as const, baseUrl: '', apiKey: '', model: 'mock', role });

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ev-pack-'));
  store = new EventStore(join(dir, 't.db'));
  ws = new Workspace(join(dir, 'data'));
  packs = new PackStore(join(dir, 'data'));
  jobs = new JobRegistry();
  store.createWorld('w1', '测试');
});

function demoPack(): StoryPack {
  return {
    id: 'pk1', worldId: 'w1', title: '测试包', characters: ['a'],
    createdAt: '',
    chapters: [
      { id: 'c1', title: '一', worldTime: 1, canonNodeId: 'n1', nodes: [
        { id: 'n1', text: '开局', options: [
          { text: '前进', tag: 'advance', nextNodeId: 'n2' },
          { text: '回原著', tag: 'canon' },
        ] },
        { id: 'n2', text: '中段', options: [{ text: '继续', nextNodeId: 'n3' }] },
      ] },
      { id: 'c2', title: '二', worldTime: 2, canonNodeId: 'n3', nodes: [
        { id: 'n3', text: '结尾', options: [] },
      ] },
    ],
  };
}

describe('StoryPack 玩侧', () => {
  it('可玩门槛：角色/章节/节点链', () => {
    const ok = packPlayable(demoPack());
    expect(ok.ok).toBe(true);
    const bad = demoPack(); bad.characters = [];
    expect(packPlayable(bad).ok).toBe(false);
    const broken = demoPack(); broken.chapters[0].nodes[0].options = [];
    expect(packPlayable(broken).ok).toBe(false);
  });

  it('canon 硬跳与 advance 推进（引擎标签白名单）', () => {
    packs.save(demoPack());
    const p = packs.get('pk1')!;
    let progress = packs.startProgress(p, 'isekai', { playMode: 'mainline' });
    expect(progress.nodeId).toBe('n1');
    // 选 0（advance）→ n2
    let r = packs.chooseOption(p, progress, 0);
    expect(r.progress.nodeId).toBe('n2');
    expect(r.jumpedCanon).toBe(false);
    progress = r.progress;
    // 在 n2 选 canon → 硬跳到本章锚点 n1
    const n2 = p.chapters[0].nodes[1];
    void n2;
    // n2 的 canon 跳转：改 n2 选项模拟
    p.chapters[0].nodes[1].options.push({ text: '回原著', tag: 'canon' });
    r = packs.chooseOption(p, progress, 1);
    expect(r.jumpedCanon).toBe(true);
    expect(r.progress.nodeId).toBe('n1');
  });
});

describe('分级与乐观锁', () => {
  it('min(user, card, global) 三方取小', () => {
    store.setWorldMaxTier('w1', 'standard');
    expect(store.resolveTier('open', 'open', 'w1')).toBe('standard'); // global 收紧
    expect(store.resolveTier('safe', 'open', 'w1')).toBe('safe');
    store.setWorldMaxTier('w1', 'open');
    expect(store.resolveTier('safe', 'standard', 'w1')).toBe('safe');
  });

  it('baseSeq 记录在提案上', async () => {
    const p = await runFunnel(store, 'w1', [
      { worldId: 'w1', actor: 'agent', worldTime: 1, kind: 'fact.set', payload: { key: 'k', value: 'v', validFrom: 1 } },
    ], mockP('adversarial'), 't');
    expect(typeof p.baseSeq).toBe('number');
  });
});

describe('埋雷基准集 v0（MD 9.1 雏形）', () => {
  const mineNovel = [
    '第一章 起点', '林澜说：开始了。她与沈青结为姐弟。',
    '第二章 变故', '三年后，林澜死于城头。全军缟素。',
    '第三章 矛盾', '又过了一年，林澜说：我回来了。众人哗然——死者复生。',
    '第四章 关系雷', '林澜改口称沈青为父亲，而非弟弟。前世埋的剑，今世要还。',
  ].join('\n');

  it('导入后：死亡事件入库、时间悖论被自动校验捕获', async () => {
    // 用 mockScripts 模拟抽取器按雷输出（真实场景由 LLM 抽取，基准测的是漏斗召回）
    const { mockScripts } = await import('@eventverse/adapters');
    mockScripts.push({
      match: /死于城头|死/,
      content: JSON.stringify({ events: [{ kind: 'char.death', payload: { id: '林澜' }, worldTimeHint: '' }] }),
    });
    mockScripts.push({
      match: /我回来了|复生/,
      content: JSON.stringify({ events: [{ kind: 'char.update', payload: { id: '林澜', patch: { attrs: { 状态: '归来' } } } }, { kind: 'location.move', payload: { charId: '林澜', place: '城头' } }] }),
    });
    try {
      const r = await importNovel(store, ws, jobs, {
        worldId: 'w1', workTitle: '埋雷书', text: mineNovel,
        extractorProvider: mockP('extractor'), adversarialProvider: mockP('adversarial'),
      });
      expect(r.chapters).toBeGreaterThanOrEqual(3);
      // 死亡提案存在
      const props = store.listProposals('w1');
      const deathProp = props.find(p => (p.events as any[]).some((e: any) => e.kind === 'char.death'));
      expect(deathProp).toBeDefined();
      // 先批准：建角色 + 死亡
      const charProp = props.find(p => (p.events as any[]).some((e: any) => e.kind === 'char.create'));
      if (charProp) { store.setProposalStatus(charProp.id, 'approved'); store.applyProposal(charProp.id); }
      // 角色兜底（mock 抽取路径可能不产出 char.create）：以作者身份直接建角色
      if (!store.stateAt('w1').characters['林澜']) {
        store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1, payload: { id: '林澜', name: '林澜' }, review: { status: 'approved' } });
      }
      // 死亡以作者身份入库（模拟批准），校验后续行动产生时间悖论
      store.append({ worldId: 'w1', actor: 'author', kind: 'char.death', worldTime: 2, payload: { id: '林澜' }, review: { status: 'approved' } });
      const paradox = autoValidate(store, 'w1', [
        { worldId: 'w1', actor: 'agent', worldTime: 4, kind: 'location.move', payload: { charId: '林澜', place: '城头' } },
      ]);
      expect(paradox.ok).toBe(false);
      expect(paradox.issues.some(i => i.includes('时间悖论'))).toBe(true);
    } finally {
      mockScripts.length = 0;
    }
  });

  it('同名 char.create 归一化为属性更新（不造重复角色）', async () => {
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1, payload: { id: 'lin', name: '林澜' }, review: { status: 'approved' } });
    const p = await runFunnel(store, 'w1', [
      { worldId: 'w1', actor: 'agent', worldTime: 2, kind: 'char.create', payload: { id: '林澜', name: '林澜', attrs: { 来源: '抽取' } } },
    ], mockP('adversarial'), 't');
    store.setProposalStatus(p.id, 'approved');
    store.applyProposal(p.id);
    const state = store.stateAt('w1');
    expect(Object.keys(state.characters).length).toBe(1);
    expect(state.characters.lin.attrs.来源).toBe('抽取');
  });
});
