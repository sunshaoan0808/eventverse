import { describe, it, expect, beforeEach } from 'vitest';
import { EventStore } from '@eventverse/core';
import { Workspace, runFunnel, autoValidate, funnelModeFor } from './index.js';
import { runRpTurn, EngineDeps, finalizeChapter } from './turn.js';
import { importNovel } from './importer.js';
import { JobRegistry } from './jobs.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

let store: EventStore;
let ws: Workspace;
let jobs: JobRegistry;
const mockP = (role: any) => ({ id: `m-${role}`, protocol: 'mock' as const, baseUrl: '', apiKey: '', model: 'mock', role });

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ev-eng-'));
  store = new EventStore(join(dir, 'test.db'));
  ws = new Workspace(join(dir, 'data'));
  jobs = new JobRegistry();
  store.createWorld('w1', '测试世界');
});

describe('漏斗', () => {
  it('自动校验：未知角色/时间悖论', () => {
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.create', worldTime: 1000, payload: { id: 'A', name: '林澜' } });
    store.append({ worldId: 'w1', actor: 'author', kind: 'char.death', worldTime: 1005, payload: { id: 'A' } });
    const bad = autoValidate(store, 'w1', [
      { worldId: 'w1', actor: 'agent', worldTime: 1010, kind: 'location.move', payload: { charId: 'A', place: '北境' } },
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.issues.some(i => i.includes('时间悖论'))).toBe(true);
  });

  it('轻事实模式分级', () => {
    expect(funnelModeFor(store, 'w1')).toBe('light');
    // semi/full 由事件量决定，此处仅验证函数不炸
    expect(['light', 'semi', 'full']).toContain(funnelModeFor(store, 'w1'));
  });

  it('runFunnel 产出 pending proposal，批准前不入库', async () => {
    const p = await runFunnel(store, 'w1', [
      { worldId: 'w1', actor: 'agent', worldTime: 1000, kind: 'char.create', payload: { id: 'B', name: '沈青' } },
    ], mockP('adversarial'), 'test');
    expect(p.status).toBe('pending');
    expect(store.stateAt('w1').characters.B).toBeUndefined();
    store.setProposalStatus(p.id, 'approved');
    store.applyProposal(p.id);
    expect(store.stateAt('w1').characters.B).toBeDefined();
  });
});

describe('拆书管道', () => {
  it('切章 + 时间归位 + 抽取进漏斗（mock 启发式）', async () => {
    const text = [
      '第一章 初见', '林澜说："你来了。"沈青点点头。她把信收进袖中。'.repeat(5),
      '第二章 风波', '三年后，战火烧至北境。沈青说："该走了。"林澜沉默。'.repeat(5),
    ].join('\n');
    const r = await importNovel(store, ws, jobs, {
      worldId: 'w1', workTitle: '测试书', text,
      extractorProvider: mockP('extractor'), adversarialProvider: mockP('adversarial'), llmChapterBudget: 0,
    });
    expect(r.chapters).toBe(2);
    expect(store.listChapters(r.workId).length).toBe(2);
    expect(store.listEvents('w1').some(e => e.kind === 'chapter.anchor')).toBe(true);
    // 启发式抽取应产出人物候选提案
    expect(r.proposals.length).toBeGreaterThanOrEqual(1);
    const chs = store.listChapters(r.workId);
    expect(chs[1].worldTime).toBeGreaterThanOrEqual(chs[0].worldTime);
    // job 状态
    const job = jobs.list()[0];
    expect(job.status).toBe('done');
  });
});

describe('RP 回合引擎', () => {
  function deps(): EngineDeps {
    return {
      store, ws,
      directorProvider: () => mockP('director'),
      rendererProvider: () => mockP('renderer'),
      extractorProvider: () => mockP('extractor'),
      adversarialProvider: () => mockP('adversarial'),
    };
  }

  it('回合产出正文 + beat + idle 断言（mock extractor 无事件 → idle）', async () => {
    const session = ws.newSession('w1', 'rp', '测试会话', null, { charId: null, focusCharId: null });
    const events: any[] = [];
    const r = await runRpTurn(deps(), session, '我推门而入', e => events.push(e));
    expect(r.content.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'beat')).toBe(true);
    expect(events.some(e => e.type === 'prose')).toBe(true);
    // mock extractor 默认抽不出事件 → idle 断言生效
    expect(r.idle).toBe(true);
    expect(events.some(e => e.type === 'idle')).toBe(true);
    const saved = ws.getSession(session.id)!;
    expect(saved.turns.at(-1)!.meta!.idle).toBe(true);
  });

  it('定稿章节：落盘 + 锚点 + 手改同步提案', async () => {
    const workId = 'wk1';
    store.createWork({ id: workId, worldId: 'w1', title: '书', createdAt: new Date().toISOString() });
    const r = await finalizeChapter(deps(), 'w1', workId, 'ch-1', '第一章', 0, 1001, '林澜说："到此为止。"', () => {});
    expect(ws.readChapterBody(workId, 'ch-1')).toContain('到此为止');
    expect(store.getChapter('ch-1')?.title).toBe('第一章');
    expect(store.listEvents('w1').some(e => e.kind === 'chapter.anchor')).toBe(true);
  });
});

describe('Workspace', () => {
  it('密钥加密往返', () => {
    const vault = ws.encryptSecret('sk-very-secret');
    expect(vault).not.toContain('sk-very-secret');
    expect(ws.decryptSecret(vault)).toBe('sk-very-secret');
  });
  it('provider 保存后 apiKey 不落明文', () => {
    ws.saveProviders([{ id: 'p1', protocol: 'openai', baseUrl: 'https://api.x.com/v1', apiKey: 'sk-123', model: 'gpt', role: 'renderer' }]);
    const loaded = ws.loadProviders();
    expect(loaded[0].apiKey).toBe('sk-123');
    const raw = JSON.parse(require('node:fs').readFileSync(ws.providersPath(), 'utf8'));
    expect(JSON.stringify(raw)).not.toContain('sk-123');
  });
});
