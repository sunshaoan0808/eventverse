// 四角色接入 Zen 免费网关（保留用户已配的渲染层）
const B = 'http://127.0.0.1:18700';
(async () => {
  const cur = (await (await fetch(B + '/api/settings')).json()).providers;
  const mk = (id, role, model) => ({ id, role, protocol: 'openai', baseUrl: 'http://127.0.0.1:9527/v1', apiKey: 'zen-3767eabf', model });
  const next = cur.map(p => {
    if (p.id === 'mock-renderer') return mk('renderer', 'renderer', 'nemotron-3-ultra-free'); // wzw 渠道 503，暂切 zen
    if (p.id === 'mock-director') return mk('director', 'director', 'laguna-s-2.1-free');
    if (p.id === 'mock-extractor') return mk('extractor', 'extractor', 'laguna-s-2.1-free');
    if (p.id === 'mock-adversarial') return mk('adversarial', 'adversarial', 'laguna-s-2.1-free');
    if (p.id === 'mock-chat') return mk('chat', 'chat', 'nemotron-3-ultra-free');
    return p;
  });
  const r = await fetch(B + '/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providers: next }) });
  console.log('save:', r.status);
  const s = await (await fetch(B + '/api/settings')).json();
  for (const p of s.providers) console.log(p.role, '|', p.protocol, p.model, '@', p.baseUrl, '| key:', p.hasKey ? '已存' : '无');
})();
