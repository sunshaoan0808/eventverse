// 三个导入功能的复现测试
const B = 'http://127.0.0.1:18700';
const j = async (p, o) => { const r = await fetch(B + p, o); return [r.status, await r.json().catch(() => ({}))]; };
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const wiz = await post('/api/wizard', { worldTitle: '导入体验复现', characters: [{ name: '主角', place: '客栈' }] });
  const w = wiz[1].worldId;
  console.log('world:', w);

  console.log('\n=== 1) 世界书：裸导出（无 entries 包裹，两种 key 字段混用）===');
  const wb1 = await post('/api/import/worldbook', { worldId: w, book: { '0': { keys: ['法术'], content: '火球术', constant: true, enabled: true }, '1': { key: ['剑法'], content: '快剑十三式', constant: true, disable: false } } });
  console.log(wb1[0], JSON.stringify(wb1[1]));

  console.log('\n=== 2) 角色卡：典型 v2 + 内嵌世界书 ===');
  const card = await post('/api/import/st-card', { worldId: w, card: { spec: 'chara_card_v2', data: { name: '夜莺', description: '神秘歌手', personality: '冷', character_book: { entries: [{ keys: ['歌'], content: '夜莺的歌能疗伤', constant: true }] } } } });
  console.log(card[0], JSON.stringify(card[1]));

  console.log('\n=== 3) 拆书：现实体量 → 提案洪水 ===');
  let t = '';
  for (let c = 1; c <= 12; c++) {
    t += `第${c}章 行路${c}\n`;
    for (let n = 0; n < 6; n++) t += `人物${(c * 7 + n) % 80}说：我们走。\n`;
  }
  const imp = await post('/api/import', { worldId: w, title: '洪水测试', text: t, llmChapterBudget: 0 });
  console.log('import resp:', imp[0], JSON.stringify(imp[1]));
  await new Promise(r => setTimeout(r, 6000));
  const job = await j('/api/jobs/' + imp[1].jobId);
  console.log('job:', job.status);
  const props = await j('/api/worlds/' + w + '/proposals');
  const pend = props.filter(p => p.status === 'pending');
  console.log('提案总数:', props.length, '| 待审:', pend.length, '→ 用户需手工处理', pend.length, '次');
  const names = pend.flatMap(p => (p.events || []).filter(e => e.kind === 'char.create').map(e => e.payload.name));
  console.log('待审人物去重前:', names.length, '去重后:', new Set(names).size);
})();
