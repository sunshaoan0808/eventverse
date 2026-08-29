// 清理污染世界 → 重新导入（对话归属版启发式）
const B = 'http://127.0.0.1:18700';
(async () => {
  for (const w of await (await fetch(B + '/api/worlds')).json()) {
    if (w.id !== 'demo') { const r = await fetch(B + '/api/worlds/' + w.id, { method: 'DELETE' }); console.log('删', w.title, r.status); }
  }
})();
