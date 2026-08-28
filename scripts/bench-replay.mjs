// 重放与工具性能基准（MD §6 风险：stateAt 全量重放的规模余量）
// 用法：node scripts/bench-replay.mjs
import { EventStore } from '@eventverse/core';
import { Workspace, importNovel, JobRegistry, executeTool } from '@eventverse/engine';
import { mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const mockP = (role) => ({ id: `m-${role}`, protocol: 'mock', baseUrl: '', apiKey: '', model: 'mock', role });

const avg = async (fn, n) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await fn();
  return Math.round((performance.now() - t0) / n * 100) / 100;
};

console.log('== EventVerse 重放/工具性能基准 ==\n');
const dir = mkdtempSync(join(tmpdir(), 'ev-bench-'));
const store = new EventStore(join(dir, 'bench.db'));
const ws = new Workspace(join(dir, 'data'));
const jobs = new JobRegistry();
store.createWorld('w', '基准世界');

// —— 1. 合成 300 章小说导入（启发式抽取，零 LLM 成本）——
const names = ['林澜', '沈青', '侯爷', '药师', '驿丞', '镖头', '掌柜', '捕头', '绣娘', '账房', '更夫', '船家'];
let novel = '';
for (let c = 1; c <= 300; c++) {
  const a = names[c % names.length], b = names[(c + 3) % names.length];
  novel += `第${c}章 山水行${c}\n${a}说："前面就是渡口。"\n${b}道："这一路行了${c * 3}里。"\n两人又说起旧事。\n`;
}
const t0 = performance.now();
const r = await importNovel(store, ws, jobs, {
  worldId: 'w', workTitle: '三百章基准书', text: novel,
  extractorProvider: mockP('extractor'), adversarialProvider: mockP('adversarial'), llmChapterBudget: 0,
});
const importMs = Math.round(performance.now() - t0);
const anchorEvents = store.listEvents('w').length;
console.log(`导入 300 章：${importMs} ms（章节 ${r.chapters}，事件 ${anchorEvents}，提案 ${r.proposals.length}）`);

// —— 2. 直灌 3000 条作者级事件（模拟长跑积累）——
const t1 = performance.now();
for (let i = 0; i < 1000; i++) {
  const ch = names[i % names.length];
  store.append({ worldId: 'w', actor: 'author', kind: 'char.create', worldTime: 1000 + i * 0.5, payload: { id: `c${i}`, name: ch + i } });
  store.append({ worldId: 'w', actor: 'author', kind: 'location.move', worldTime: 1000 + i * 0.5, payload: { charId: `c${i}`, place: `地点${i % 50}` } });
  store.append({ worldId: 'w', actor: 'author', kind: 'fact.set', worldTime: 1000 + i * 0.5, payload: { key: `setting:条目${i}`, value: '值' + i, validFrom: 1000 + i * 0.5 } });
}
console.log(`直灌 3000 事件：${Math.round(performance.now() - t1)} ms`);
const total = store.listEvents('w').length;
console.log(`事件总量：${total}\n`);

// —— 3. 关键路径延迟 ——
const ctx = { store, ws, worldId: 'w', workId: r.workId, viewerCharId: null, viewerState: null, adversarialProvider: mockP('adversarial'), sourceLabel: 'bench' };
// 对齐真实调用模式：可见状态每回合预算一次
ctx.viewerCharId = 'c500';
ctx.viewerState = store.stateVisibleTo('w', 'c500');
const rows = [
  ['stateAt 全量重放（缓存命中）', await avg(() => store.stateAt('w'), 20)],
  ['stateVisibleTo（单次预算成本）', await avg(() => store.stateVisibleTo('w', 'c500'), 5)],
  ['diff 两时刻', await avg(() => store.diff('w', { worldTime: 1100 }, { worldTime: 1400 }), 10)],
  ['timeline', await avg(() => store.timeline('w'), 10)],
  ['工具 grep', await avg(() => executeTool(ctx, 'grep', { keyword: '渡口', limit: 8 }), 10)],
  ['工具 search_entities（复用 viewerState）', await avg(() => executeTool(ctx, 'search_entities', { query: '林澜' }), 20)],
  ['工具 story_index', await avg(() => executeTool(ctx, 'story_index', {}), 5)],
  ['工具 recall（复用 viewerState）', await avg(() => executeTool(ctx, 'recall', { about: 'world' }), 20)],
];
console.log('路径 | 平均延迟(ms)');
console.log('--- | ---');
for (const [k, v] of rows) console.log(`${k} | ${v}`);

// —— 4. 预算内最坏情况：单回合 12 次工具全走 search ——
const t2 = performance.now();
for (let i = 0; i < 12; i++) await executeTool(ctx, 'search_entities', { query: names[i % names.length] });
console.log(`\n最坏回合（12×search_entities）：${Math.round(performance.now() - t2)} ms`);
console.log('\n结论参考：单回合引擎预算内工具总耗时应 < 2s（超过则需上投影缓存，MD §6）');
