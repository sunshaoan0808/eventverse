// 真实模型端到端验证：RP 一轮 + 世界问答
const B = 'http://127.0.0.1:18700';
const post = async (p, body) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

(async () => {
  // 1) 建 RP 会话（扮演 lin）
  const s = await (await post('/api/sessions', { worldId: 'demo', mode: 'rp', title: '真实模型首跑', profile: { charId: 'lin', focusCharId: 'shen' } })).json();
  console.log('session:', s.id);

  // 2) 跑一轮
  const r = await post(`/api/sessions/${s.id}/turn`, { message: '雪夜里我潜入质子府，想当面问问沈青布防图的事。' });
  const text = await r.text();
  const events = [...text.matchAll(/event: (.+)\ndata: (.+)/g)].map(m => ({ e: m[1], d: m[2] }));
  const get = (name) => events.filter(x => x.e === name).map(x => x.e === 'content' ? JSON.parse(x.d) : JSON.parse(x.d));
  const beat = get('beat')[0]?.d;
  const content = get('content').map(x => x.d).join('');
  const prose = get('prose')[0]?.d;
  const errs = get('error');
  console.log('\n--- beat（导演，laguna）---');
  console.log(beat ? (beat.beats ?? JSON.stringify(beat)).slice(0, 150) : '(无)');
  console.log('--- 正文（渲染，glm-5.2-fast）前200字 ---');
  console.log((content || '(空)').slice(0, 200));
  console.log('\n--- 文风 ---', prose ? `${prose.verdict} AI腔${prose.aiClicheDensity}/千字` : '无');
  console.log('提案事件:', get('proposal').length ? '有' : '无', '| 错误:', errs.length ? errs.map(x => x.d.message).join(';').slice(0, 200) : '无');

  // 3) 世界问答（chat + nemotron，走工具）
  const cr = await post('/api/chat', { worldId: 'demo', message: '林澜和沈青是什么关系？现在林澜在哪？' });
  const ct = await cr.text();
  const tools = [...ct.matchAll(/event: tool\ndata: (.+)/g)].map(m => JSON.parse(m[1]).name);
  const ans = ct.split('event: content\ndata: ')[1]?.split('\n')[0];
  console.log('\n--- 问答 ---');
  console.log('工具链:', tools.join(' → ') || '(无)');
  console.log('回答:', (ans || '').slice(0, 200).replace(/\\n/g, ' '));
})();
