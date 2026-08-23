import { describe, it, expect } from 'vitest';
import { splitHistory, estimateTurnTokens, shouldCompress, CONTEXT_BUDGET_TOKENS, compressSession } from './turn.js';
import { EventStore } from '@eventverse/core';
import { Workspace } from './workspace.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

describe('回合 token 预算与压缩（MD §6）', () => {
  it('splitHistory：保留最近 keep 轮', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: 't' + i, at: '' }));
    const { recent, older } = splitHistory(turns, 12);
    expect(recent.length).toBe(12);
    expect(older.length).toBe(8);
    expect(recent[0].content).toBe('t8');
  });

  it('estimateTurnTokens 与 shouldCompress 阈值（95%）', () => {
    const small = ['x'.repeat(100)];
    expect(shouldCompress(small, 10000)).toBe(false);
    // 中文 ~1.6 字/token：1.6 万字 ≈ 1 万 token，预算 1 万 → 95% 触发
    const big = ['x'.repeat(16000)];
    expect(estimateTurnTokens(big)).toBeGreaterThan(9000);
    expect(shouldCompress(big, 10000)).toBe(true);
    expect(CONTEXT_BUDGET_TOKENS).toBeGreaterThan(0);
  });

  it('compressSession：≥40 轮触发压缩，mock 摘要落盘、turns 减半（机械降级路径）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ev-cmp-'));
    const store = new EventStore(join(dir, 't.db'));
    const ws = new Workspace(join(dir, 'data'));
    store.createWorld('w', 'x');
    const deps: any = {
      store, ws,
      extractorProvider: () => ({ id: 'm', protocol: 'mock', baseUrl: '', apiKey: '', model: 'mock', role: 'extractor' }),
    };
    const session = ws.newSession('w', 'rp', '压缩测试', null);
    for (let i = 0; i < 45; i++) session.turns.push({ role: i % 2 ? 'assistant' : 'user', content: `第${i}轮：${'内容'.repeat(20)}`, at: '' });
    const before = session.turns.length;
    const changed = await compressSession(deps, session);
    expect(changed).toBe(true);
    expect(before).toBe(45);
    expect(session.turns.length).toBeLessThan(before);
    expect(session.summary).toBeTruthy();
    expect(session.compressedAt).toBeTruthy();
    // 不足 40 轮不压缩
    const s2 = ws.newSession('w', 'rp', '短会话', null);
    expect(await compressSession(deps, s2)).toBe(false);
  });
});
