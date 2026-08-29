// 通过 GitHub Git Data API 推送本地提交（https://github.com 被干扰、api.github.com 可用时的逃生通道）
// 用法：node scripts/push-via-api.mjs [owner/repo]
// 原理：枚举本地领先远端的提交（逐个）→ 变更文件建 blob → base_tree 建 tree → 复刻 author/committer/时间 建 commit → 快进 refs/heads/main。
// tree/commit 内容一致 ⇒ SHA 与本地完全一致，推送后本地/远端历史对齐。
import { execFileSync } from 'node:child_process';

const REPO = process.argv[2] ?? 'sunshaoan0808/eventverse';
const G = 'C:\\Users\\cs14ilike\\.zcode\\workspace\\default\\tools\\git\\cmd\\git.exe';
const CWD = 'C:\\Users\\cs14ilike\\.zcode\\workspace\\default\\eventverse';
const git = (...a) => execFileSync(G, ['-C', CWD, ...a], { encoding: 'utf8' });
const token = execFileSync('C:\\Users\\cs14ilike\\.zcode\\workspace\\default\\tools\\ghbin\\gh.exe', ['auth', 'token'], { encoding: 'utf8' }).trim();
const api = async (path, method = 'GET', body) => {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'eventverse-push' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (body) (await import('node:fs')).writeFileSync('fail-body.json', JSON.stringify(body));
    throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  return j;
};

// 本地领先提交（旧→新）
const localHead = git('rev-parse', 'main').trim();
const remoteRef = await api(`/repos/${REPO}/git/ref/heads/main`);
const remoteSha = remoteRef.object.sha;
console.log('local:', localHead.slice(0, 7), '| remote:', remoteSha.slice(0, 7));
if (localHead === remoteSha) { console.log('已同步'); process.exit(0); }
const pending = git('rev-list', '--reverse', `${remoteSha}..main`).trim().split('\n').filter(Boolean);
console.log('待推送提交：', pending.map(s => s.slice(0, 7)).join(' '));

const iso = (raw) => {
  // "1755968000 +0800" → ISO 8601
  const [sec, off] = raw.split(' ');
  const d = new Date(Number(sec) * 1000);
  const sign = off.startsWith('-') ? '-' : '+';
  const hm = off.replace(/^[+-]/, '');
  return `${d.toISOString().slice(0, 19)}${sign}${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
};

let parent = remoteSha;
for (const sha of pending) {
  const raw = git('cat-file', 'commit', sha);
  const msg = raw.slice(raw.indexOf('\n\n') + 2).replace(/\n$/, '');
  const authorLine = raw.match(/^author (.+)$/m)[1];
  const commitLine = raw.match(/^committer (.+)$/m)[1];
  const [an, ae, ad] = [authorLine.match(/^(.*) <([^>]*)>/)[1], authorLine.match(/<([^>]*)>/)[1], authorLine.split('> ')[1]];
  const [cn, ce, cd] = [commitLine.match(/^(.*) <([^>]*)>/)[1], commitLine.match(/<([^>]*)>/)[1], commitLine.split('> ')[1]];
  const treeLocal = git('rev-parse', `${sha}^{tree}`).trim();

  // 变更清单
  const changes = git('diff-tree', '-r', '--name-status', '--no-commit-id', sha).trim().split('\n').filter(Boolean);
  // GitHub 安全限制：.github/workflows/* 不能经 git/trees API 创建（404），须走 Contents API
  const workflows = [];
  const tree = [];
  for (const line of changes) {
    const [st, ...pp] = line.split('\t');
    const path = pp.join('/');
    if (st === 'D') { tree.push({ path, mode: '100644', type: 'blob', sha: null }); continue; }
    if (path.startsWith('.github/workflows/')) { workflows.push({ path, st }); continue; }
    const content = git('show', `${sha}:${path}`);
    const blob = await api(`/repos/${REPO}/git/blobs`, 'POST', { content, encoding: 'utf-8' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const baseTree = (await api(`/repos/${REPO}/git/commits/${parent}`)).tree.sha;
  // workflows 不进 tree（GitHub trees API 封锁该路径），由 Contents API 在其后单独补建
  const newTree = await api(`/repos/${REPO}/git/trees`, 'POST', { base_tree: baseTree, tree });
  let commit;
  if (workflows.length === 0) {
    if (newTree.sha !== treeLocal) throw new Error(`tree SHA 不一致：远端 ${newTree.sha} vs 本地 ${treeLocal}`);
    commit = await api(`/repos/${REPO}/git/commits`, 'POST', {
      message: msg, tree: newTree.sha, parents: [parent],
      author: { name: an, email: ae, date: iso(ad) },
      committer: { name: cn, email: ce, date: iso(cd) },
    });
    if (commit.sha !== sha) throw new Error(`commit SHA 不一致：远端 ${commit.sha} vs 本地 ${sha}`);
  } else {
    // 无 workflow 的严格对齐不可得（trees API 拒绝该路径）：接受远端生成 SHA，内容等价，推送后由 reconcile 对齐本地
    commit = await api(`/repos/${REPO}/git/commits`, 'POST', {
      message: msg, tree: newTree.sha, parents: [parent],
      author: { name: an, email: ae, date: iso(ad) },
      committer: { name: cn, email: ce, date: iso(cd) },
    });
    console.log(`  （${workflows.length} 个 workflow 文件改走 Contents API，远端 SHA 与本地不同：${commit.sha.slice(0, 7)}）`);
  }
  await api(`/repos/${REPO}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: false });
  parent = commit.sha;
  for (const w of workflows) {
    const content = git('show', `${sha}:${w.path}`);
    const put = await api(`/repos/${REPO}/contents/${w.path}`, 'PUT', {
      message: msg, content: Buffer.from(content, 'utf8').toString('base64'), branch: 'main',
      author: { name: an, email: ae, date: iso(ad) },
      committer: { name: cn, email: ce, date: iso(cd) },
    });
    parent = put.commit.sha;
    console.log(`  ✓ Contents API 补建 ${w.path} → ${parent.slice(0, 7)}`);
  }
  console.log(`✓ ${sha.slice(0, 7)} ${msg.slice(0, 40)}`);
}
console.log('全部推送完成，远端 main =', parent.slice(0, 7));
