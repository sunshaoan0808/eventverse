// 新功能 E2E：向导 / 世界书导入 / 成本门 / chat 顺序 / resume
const B = 'http://127.0.0.1:18700';
const j = (r) => r.json();

async function main() {
  await new Promise(r => setTimeout(r, 2000));

  // 1) 开书向导
  const wiz = await j(await fetch(`${B}/api/wizard`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      worldTitle: 'E2E向导世界', era: '旧朝倾覆', baseYear: 500, guidance: '短句',
      characters: [{ name: '甲', gender: '女', desc: '剑客', place: '孤城' }, { name: '乙', gender: '男', desc: '说书人' }],
      relations: [{ from: '甲', to: '乙', type: '宿敌', secret: true }],
      facts: [{ key: '王朝', value: '大衍' }],
    }),
  }));
  console.log('wizard:', JSON.stringify(wiz));
  const st = await j(await fetch(`${B}/api/worlds/${wiz.worldId}/state`));
  const ok1 = Object.keys(st.characters).length === 2 && st.relations.some(r => r.type === '宿敌') && st.facts.some(f => f.value === '大衍');
  console.log('wizard state ok:', ok1, '| 秘密关系可见性:', JSON.stringify((await j(await fetch(`${B}/api/worlds/${wiz.worldId}/events`))).find(e => e.kind === 'relation.set')?.visibility));

  // 2) 世界书导入
  const wb = await j(await fetch(`${B}/api/import/worldbook`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldId: wiz.worldId, book: { entries: { '0': { keys: ['秘术'], content: '引雷诀，失传百年', constant: true, enabled: true }, '1': { keys: ['废'], content: '停用条目', constant: true, enabled: false } } } }),
  }));
  const st2 = await j(await fetch(`${B}/api/worlds/${wiz.worldId}/state`));
  console.log('worldbook:', JSON.stringify(wb), '| lore 入库:', st2.facts.some(f => f.key === 'lore:秘术'));

  // 3) 成本门：无用量 → 400；demo 世界有用量 → baseline + gate
  const g0 = await fetch(`${B}/api/worlds/${wiz.worldId}/usage/baseline`, { method: 'POST' });
  console.log('baseline 无用量 →', g0.status, '(期望 400)');
  const bl = await j(await fetch(`${B}/api/worlds/demo/usage/baseline`, { method: 'POST' }));
  const gate = await j(await fetch(`${B}/api/worlds/demo/usage/gate`));
  console.log('baseline:', JSON.stringify(bl), '| gate roles:', gate.roles.length, 'breached:', gate.breached.length);

  // 4) chat 顺序：history 应保持原序且 user 在最后（mock 无 toolCalls → 直接 content）
  const chat = await fetch(`${B}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ worldId: 'demo', message: '林澜在哪？', history: [{ role: 'user', content: '之前问过' }, { role: 'assistant', content: '之前答过' }] }),
  });
  const txt = await chat.text();
  console.log('chat SSE 事件:', [...txt.matchAll(/event: (.+)/g)].map(m => m[1]).join(','), '| 有正文:', /event: content/.test(txt));

  // 5) resume：新建一个导入任务 → 立即 cancel → cursor=0 时应 409（无可续游标）
  const imp = await j(await fetch(`${B}/api/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ worldId: 'demo', title: '续跑测试', text: '第一章 A\n林澜说：开始。\n'.repeat(30), llmChapterBudget: 0 }) }));
  await fetch(`${B}/api/jobs/${imp.jobId}/cancel`, { method: 'POST' });
  await new Promise(r => setTimeout(r, 2500));
  const job = await j(await fetch(`${B}/api/jobs/${imp.jobId}`));
  console.log('import job:', job.status, 'cursor:', job.cursor, 'workId:', job.result?.workId);
  const resume = await fetch(`${B}/api/jobs/${imp.jobId}/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '第一章 A\n林澜说：开始。\n'.repeat(30) }) });
  if (resume.status === 409) {
    console.log('resume cursor=0 →', resume.status, '(符合预期：游标为 0 无可续)');
  } else {
    const rj = await resume.json();
    console.log('resume →', resume.status, JSON.stringify(rj));
    await new Promise(r => setTimeout(r, 3000));
    const nj = await j(await fetch(`${B}/api/jobs/${rj.jobId}`));
    console.log('resumed job:', nj.status, nj.progress + '/' + nj.total, 'resumedFrom:', nj.result?.resumedFrom);
  }
}
main().catch(e => { console.error('E2E FAIL:', e.message); process.exit(1); });
