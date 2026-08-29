// 真实作品导入：《此间的少年》→ 新世界「此间的少年」
import { readFileSync } from 'node:fs';
const B = 'http://127.0.0.1:18700';
const j = async (p, o) => { const r = await fetch(B + p, o); return [r.status, await r.json().catch(() => ({}))]; };
const post = (p, body) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  const buf = readFileSync('C:/Users/cs14ilike/Documents/此间的少年.txt');
  let text = new TextDecoder('utf-8').decode(buf);
  if ((text.match(/\uFFFD/g) || []).length > buf.length * 0.001) {
    text = new TextDecoder('gbk').decode(buf);
    console.log('编码：GBK');
  }
  console.log('原文:', text.length, '字符');
  const [, w] = await post('/api/worlds', { title: '此间的少年（江南）' });
  const worldId = w.id;
  console.log('世界:', worldId);
  const [st, imp] = await post('/api/import', {
    worldId, title: '此间的少年', text, baseYear: 1056, llmChapterBudget: 10,
  });
  console.log('job:', st, imp.jobId);
  // 轮询
  for (let i = 0; i < 240; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const [, job] = await j('/api/jobs/' + imp.jobId);
    if (i % 4 === 0 || job.status !== 'running') console.log(`[${job.status}] ${job.progress}/${job.total} ${job.label}`);
    if (['done', 'error', 'cancelled'].includes(job.status)) {
      console.log('\n=== 结果 ===');
      console.log('workId:', job.result?.workId, '| 章节数:', job.result?.chapters, '| 提案:', job.result?.proposals, '| 自动落库:', job.result?.applied);
      const state = (await j('/api/worlds/' + worldId + '/state'))[1];
      console.log('人物:', Object.values(state.characters).map(c => c.name).join('、'));
      console.log('关系:', state.relations.map(r2 => `${r2.from}—${r2.type}→${r2.to}`).slice(0, 10).join('；'));
      console.log('设定条目:', state.facts.length, '| 事件总量:', (await j('/api/worlds/' + worldId + '/events'))[1].length);
      if (job.status === 'error') console.log('错误:', job.error);
      process.exit(0);
    }
  }
})();
