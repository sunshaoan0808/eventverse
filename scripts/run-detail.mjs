import { execFileSync } from 'node:child_process';
const GH = 'C:\\Users\\cs14ilike\\.zcode\\workspace\\default\\tools\\ghbin\\gh.exe';
const get = (p) => {
  for (let i = 0; i < 6; i++) {
    try { return execFileSync(GH, ['api', p], { encoding: 'utf8' }); }
    catch { /* 网络抖动重试 */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  return '[]';
};
const info = JSON.parse(get('repos/sunshaoan0808/eventverse/actions/runs/33240810333'));
console.log('run:', info.name, '| head:', info.head_sha.slice(0, 7), '| event:', info.event, '| 结论:', info.conclusion);
const ann = JSON.parse(get(`repos/sunshaoan0808/eventverse/commits/${info.head_sha}/check-runs`));
for (const c of ann.check_runs ?? []) {
  console.log(`[${c.name}] ${c.conclusion} ${c.output?.title ?? ''}`);
  if (c.output?.annotations_url) {
    const a = JSON.parse(get(c.output.annotations_url.replace('https://api.github.com', '')));
    for (const x of a) console.log('  ·', x.annotation_level + ':', x.message);
  }
}
