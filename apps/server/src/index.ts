// EventVerse server：零框架 HTTP + SSE + 静态托管（MD 8：本地优先，默认 127.0.0.1）
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventStore, NewEventInput } from '@eventverse/core';
import { Workspace, JobRegistry, EngineDeps, runRpTurn, runWriteDraft, rewriteSelection, finalizeChapter, runToolChat, importNovel, ToolContext, funnelModeFor, autoValidate, normalizeRefs, regressionGate, worldMetrics, redTeamScan } from '@eventverse/engine';
import { PackStore, StoryPack, packPlayable, newPackId, newNodeId } from '@eventverse/engine';
import { parseSTCard, extractCardFromPng, normalizeWorldBook, exportWorldBookFromFacts, ProviderConfig, newId, timeLabel, callLLM, extractJson } from '@eventverse/adapters';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录 = 项目根 data/（dist 在 apps/server/dist，回退三级）；与 Docker 卷 ./data 对应
const DATA_DIR = process.env.EVENTVERSE_DATA ?? join(__dirname, '../../../data');
const PORT = Number(process.env.EVENTVERSE_PORT ?? 18700);
const HOST = process.env.EVENTVERSE_HOST ?? '127.0.0.1';
const WEB_DIST = process.env.EVENTVERSE_WEB ?? join(__dirname, '../../web/dist');

mkdirSync(DATA_DIR, { recursive: true });

const store = new EventStore(join(DATA_DIR, 'eventverse.db'));
const ws = new Workspace(DATA_DIR);
const jobs = new JobRegistry();
const packs = new PackStore(DATA_DIR);

const deps: EngineDeps = {
  store, ws,
  directorProvider: () => ws.providerFor('director'),
  rendererProvider: () => ws.providerFor('renderer'),
  extractorProvider: () => ws.providerFor('extractor'),
  adversarialProvider: () => ws.providerFor('adversarial'),
};

// 首次启动：内置演示世界（开箱即用）
function seedDemo() {
  const worlds = store.listWorlds();
  if (worlds.length) {
    seedDemoPack();
    return;
  }
  store.createWorld('demo', '演示世界：双城');
  store.append({ worldId: 'demo', actor: 'author', kind: 'fact.set', worldTime: 1000, worldTimeLabel: '1000 年', payload: { key: 'setting:格局', value: '北壤与南川两城对峙，冷战三十年', validFrom: 1000 }, review: { status: 'approved' } });
  store.append({ worldId: 'demo', actor: 'author', kind: 'char.create', worldTime: 1000, payload: { id: 'lin', name: '林澜', gender: '女', attrs: { 身份: '北壤密探', 特征: '左腕旧伤' } }, review: { status: 'approved' } });
  store.append({ worldId: 'demo', actor: 'author', kind: 'char.create', worldTime: 1000, payload: { id: 'shen', name: '沈青', gender: '男', attrs: { 身份: '南川质子' } }, review: { status: 'approved' } });
  store.append({ worldId: 'demo', actor: 'author', kind: 'char.create', worldTime: 1000, payload: { id: 'hou', name: '侯爷', gender: '男', attrs: { 身份: '北壤权臣' } }, review: { status: 'approved' } });
  store.append({ worldId: 'demo', actor: 'author', kind: 'relation.set', worldTime: 1000, payload: { id: 'r1', from: 'lin', to: 'hou', type: '上下级', validFrom: 1000 }, review: { status: 'approved' } });
  store.append({ worldId: 'demo', actor: 'author', kind: 'relation.set', worldTime: 1002, payload: { id: 'r2', from: 'lin', to: 'shen', type: '旧识', validFrom: 1002 }, visibility: { knowers: ['lin', 'shen'], scope: 'group' }, review: { status: 'approved' } });
  store.append({ worldId: 'demo', actor: 'author', kind: 'location.move', worldTime: 1000, payload: { charId: 'lin', place: '北壤·酒肆' } }, );
  store.append({ worldId: 'demo', actor: 'author', kind: 'location.move', worldTime: 1000, payload: { charId: 'shen', place: '北壤·质子府' } });
  store.append({ worldId: 'demo', actor: 'author', kind: 'foreshadow.plant', worldTime: 1000, payload: { id: 'f1', description: '沈青袖中藏有南川布防图', deadlineWorldTime: 1010 }, review: { status: 'approved' } });
  store.addGuidance({ title: '文风', description: '冷峻短句，少形容词，对话推动叙事', source: 'seed', active: true, worldId: 'demo' } as any);

  const workId = newId('work');
  store.createWork({ id: workId, worldId: 'demo', title: '双城记·残卷', createdAt: new Date().toISOString() });
  const ch1 = newId('ch');
  ws.writeChapterBody(workId, ch1, '北壤落了今冬第一场雪。\n林澜坐在酒肆最暗的角落，指尖敲着杯沿。对面的质子府亮着灯——沈青回来三年了，两人在城里遇见过四次，只说过一次话。\n"姑娘，打烊了。"\n她放下酒钱，走进雪里。');
  store.saveChapter({ id: ch1, workId, title: '第一章 雪', index: 0, worldTime: 1003, worldTimeLabel: timeLabel(1003), kind: 'body', wordCount: 120 });
  store.append({ worldId: 'demo', workId, worldTime: 1003, actor: 'author', kind: 'chapter.anchor', payload: { workId, chapterId: ch1, title: '第一章 雪' }, review: { status: 'approved' } });
  console.log('[seed] 演示世界已创建：demo /《双城记·残卷》');
  seedDemoPack();
}
seedDemo();

function seedDemoPack() {
  if (!packs.list('demo').length) {
    const n = newNodeId, mk = (id: string, text: string, options: any[]) => ({ id, text, options });
    const nA = n(), nB = n(), nC = n(), nD = n(), nE = n();
    const demoPack: StoryPack = {
      id: newPackId(), worldId: 'demo', title: '双城·雪夜线', description: '演示剧本包：质子府一夜',
      characters: ['lin', 'shen', 'hou'], createdAt: new Date().toISOString(),
      chapters: [
        {
          id: 'pkc1', title: '质子府夜话', worldTime: 1003, canonNodeId: nA, nodes: [
            mk(nA, '雪夜。你（林澜）奉侯爷之命潜入质子府核实密报，却在廊下撞见沈青独自煮茶。他似乎早知道你会来。', [
              { text: '亮出密信，直问布防图', tag: 'advance', nextNodeId: nB },
              { text: '收起密信，假装路过的暗探', tag: 'idle' },
              { text: '回酒肆复命，放弃任务（回归原著）', tag: 'canon' },
            ]),
            mk(nB, '沈青承认袖中藏图，但提出交换：他想要北壤的一份出城文牒。窗外脚步声逼近——巡夜卫队。', [
              { text: '答应交换，先应付卫队', tag: 'advance', nextNodeId: nC },
              { text: '翻窗就走，带走图再说', tag: 'advance', nextNodeId: nD },
            ]),
            mk(nC, '你替沈青遮掩过去。卫队走后，两人第一次说起了三年前的旧事——你们原来早就是旧识。', [
              { text: '追问他到底瞒了什么', tag: 'advance', nextNodeId: nE },
              { text: '就此别过，天亮前出城', tag: 'idle' },
            ]),
          ],
        },
        {
          id: 'pkc2', title: '城门风声', worldTime: 1004, canonNodeId: nD, nodes: [
            mk(nD, '你带着布防图翻出质子府，落在城门暗巷。侯爷的人已在等——他们要的不止是图。', [
              { text: '交图，换取信任', tag: 'advance', nextNodeId: nE },
              { text: '扣下图，反客为主', tag: 'idle' },
              { text: '按原著：图归侯爷，你继续当密探', tag: 'canon' },
            ]),
            mk(nE, '天将亮。布防图的秘密、质子的野心、侯爷的交易——都在你手里。雪停了，双城的命运由下一句话决定。（本线暂完）', []),
          ],
        },
      ],
    };
    packs.save(demoPack);
    console.log('[seed] 演示剧本包已创建：' + demoPack.title);
  }
}

// ---------------- HTTP 基础设施 ----------------

interface Ctx { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; query: URLSearchParams; body: any }

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { return { _raw: raw }; }
}

function json(res: ServerResponse, data: any, status = 200) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function sseInit(res: ServerResponse) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
}
function sseSend(res: ServerResponse, event: string, data: any) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

type Handler = (ctx: Ctx) => Promise<void> | void;

const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:[^/]+/g, seg => { keys.push(seg.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, handler });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); return res.end(); }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => params[k] = m[i + 1]);
      const ctx: Ctx = { req, res, params, query: url.searchParams, body: ['GET', 'HEAD'].includes(req.method ?? '') ? {} : await readBody(req) };
      res.setHeader('access-control-allow-origin', '*');
      return await r.handler(ctx);
    }
    // 静态资源（web dist）
    if (req.method === 'GET' && serveStatic(pathname, res, url.searchParams)) return;
    json(res, { error: 'not found', path: pathname }, 404);
  } catch (e: any) {
    try { json(res, { error: String(e?.message ?? e) }, 500); } catch { /* closed */ }
  }
});

function serveStatic(pathname: string, res: ServerResponse, query?: URLSearchParams): boolean {
  if (!existsSync(WEB_DIST)) return false;
  let file = pathname === '/' ? '/index.html' : pathname;
  let p = join(WEB_DIST, file);
  if (!existsSync(p) || statSync(p).isDirectory()) p = join(WEB_DIST, 'index.html'); // SPA fallback
  if (!existsSync(p)) return false;
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
  };
  const buf = readFileSync(p);
  const headers: Record<string, any> = { 'content-type': types[extname(p)] ?? 'application/octet-stream', 'content-length': buf.length, 'cache-control': extname(p) === '.html' ? 'no-cache' : 'public,max-age=3600' };
  // ?fresh=1：清空站点存储（杀死锁死旧构建的 Service Worker），一次性逃生门
  if (query?.get('fresh') === '1') headers['clear-site-data'] = '"cache","storage"';
  res.writeHead(200, headers);
  res.end(buf);
  return true;
}

// ---------------- 业务路由 ----------------

// 世界级指标（千回合 idle 率 / 文风分布）与红队泄漏扫描（MD §9.2/9.4）
route('GET', '/api/worlds/:id/metrics', ctx => {
  json(ctx.res, worldMetrics(ws.listSessions(ctx.params.id)));
});
route('GET', '/api/worlds/:id/redteam', ctx => {
  json(ctx.res, redTeamScan(store, ctx.params.id));
});
// schema 迁移演练端点（幂等）
route('POST', '/api/migrate/legacy-events', ctx => {
  json(ctx.res, store.migrateLegacyEvents(ctx.body?.worldId ?? undefined));
});

route('GET', '/api/health', ctx => json(ctx.res, { ok: true, version: '1.0.0', worlds: store.listWorlds().length, funnelDemo: funnelModeFor(store, 'demo') }));

// ---------- 开书向导（Session Zero，MD §5.3）：15 分钟从零建出可用世界 ----------
route('POST', '/api/wizard', ctx => {
  const b = ctx.body;
  const worldId = b.worldId || newId('world');
  const created = !b.worldId;
  if (created) store.createWorld(worldId, b.worldTitle || '新世界');
  const base = Number(b.baseYear ?? 1000);
  const approved = { status: 'approved' as const, by: 'wizard' };
  let events = 0;
  // 第 1 步：世界骨架（纪元锚点 + 粗历法设定）
  if (b.era) store.append({ worldId, actor: 'author', worldTime: base, worldTimeLabel: timeLabel(base), kind: 'fact.set', payload: { key: 'setting:纪元', value: String(b.era), validFrom: base }, review: approved, sourceRef: 'wizard' });
  // 第 2 步：核心人物
  const nameToId = new Map<string, string>();
  for (const c of b.characters ?? []) {
    if (!c?.name) continue;
    const id = newId('char');
    nameToId.set(c.name, id);
    store.append({ worldId, actor: 'author', worldTime: base, kind: 'char.create', payload: { id, name: c.name, gender: c.gender, attrs: c.desc ? { 简介: String(c.desc) } : {} }, review: approved, sourceRef: 'wizard' });
    if (c.place) store.append({ worldId, actor: 'author', worldTime: base, kind: 'location.move', payload: { charId: id, place: String(c.place) }, review: approved, sourceRef: 'wizard' });
    events += c.place ? 2 : 1;
  }
  // 第 3 步：初始关系（含秘密可见性）
  for (const r of b.relations ?? []) {
    const from = nameToId.get(r.from), to = nameToId.get(r.to);
    if (!from || !to) continue;
    store.append({ worldId, actor: 'author', worldTime: base, kind: 'relation.set', payload: { id: newId('rel'), from, to, type: String(r.type ?? '相识'), validFrom: base }, visibility: r.secret ? { knowers: [from, to], scope: 'secret' } : { knowers: '*', scope: 'public' }, review: approved, sourceRef: 'wizard' });
    events++;
  }
  for (const f of b.facts ?? []) {
    if (!f?.key) continue;
    store.append({ worldId, actor: 'author', worldTime: base, kind: 'fact.set', payload: { key: String(f.key).startsWith('setting:') ? f.key : `setting:${f.key}`, value: String(f.value ?? ''), validFrom: base }, review: approved, sourceRef: 'wizard' });
    events++;
  }
  if (b.guidance) store.addGuidance({ title: '文风', description: String(b.guidance), source: 'wizard', active: true, worldId } as any);
  json(ctx.res, { worldId, created, events, chars: nameToId.size }, 201);
});

// ---------- 独立世界书 JSON 导入（与导出对称，MD §5.5） ----------
route('POST', '/api/import/worldbook', ctx => {
  const worldId = String(ctx.body.worldId ?? '');
  if (!worldId) return json(ctx.res, { error: 'worldId required' }, 400);
  const entries = normalizeWorldBook(ctx.body.book);
  if (!entries.length) return json(ctx.res, { error: '世界书为空或格式不识别（需 ST entries 对象/数组）' }, 400);
  const base = Number(ctx.body.worldTime ?? 1000);
  let n = 0;
  for (const e of entries) {
    if (!e.enabled) continue;
    const key = `lore:${e.keys[0] ?? e.comment ?? newId('e')}`;
    store.append({ worldId, actor: 'author', worldTime: base, kind: 'fact.set', payload: { key, value: e.content.slice(0, 2000), validFrom: base }, review: { status: 'approved', by: 'worldbook' }, sourceRef: 'worldbook-import' });
    n++;
  }
  json(ctx.res, { ok: true, imported: n, skipped: entries.length - n }, 201);
});

// ---------- 成本基线与涨幅审批门（MD §9.4） ----------
function roleAverages(worldId: string): Array<{ role: string; calls: number; avgIn: number; avgOut: number }> {
  const rows = store.db.prepare('SELECT role, COUNT(*) c, AVG(input_tokens) ai, AVG(output_tokens) ao FROM usage_log WHERE world_id=? GROUP BY role').all(worldId) as any[];
  return rows.map(r => ({ role: r.role, calls: r.c, avgIn: Math.round(r.ai ?? 0), avgOut: Math.round(r.ao ?? 0) }));
}
route('GET', '/api/worlds/:id/usage/gate', ctx => {
  const cur = roleAverages(ctx.params.id);
  const base = store.db.prepare('SELECT * FROM cost_baseline WHERE world_id=?').all(ctx.params.id) as any[];
  const roles = cur.map(c => {
    const b = base.find(x => x.role === c.role);
    if (!b) return { ...c, status: 'no-baseline' as const };
    const delta = ((c.avgIn + c.avgOut) - (b.avg_in + b.avg_out)) / Math.max(1, b.avg_in + b.avg_out);
    return { ...c, baseline: { avgIn: b.avg_in, avgOut: b.avg_out }, deltaPct: Math.round(delta * 1000) / 10, status: delta > 0.2 ? ('breached' as const) : ('ok' as const) };
  });
  json(ctx.res, { breached: roles.filter(r => r.status === 'breached'), roles });
});
route('POST', '/api/worlds/:id/usage/baseline', ctx => {
  const cur = roleAverages(ctx.params.id);
  if (!cur.length) return json(ctx.res, { error: '暂无用量，先跑几轮会话' }, 400);
  store.db.prepare('DELETE FROM cost_baseline WHERE world_id=?').run(ctx.params.id);
  const ins = store.db.prepare('INSERT INTO cost_baseline (world_id, role, avg_in, avg_out, calls, created_at) VALUES (?,?,?,?,?,?)');
  for (const c of cur) ins.run(ctx.params.id, c.role, c.avgIn, c.avgOut, c.calls, new Date().toISOString());
  json(ctx.res, { ok: true, roles: cur.length });
});

// ---------- Jobs 断点续跑（MD §2.4） ----------
route('POST', '/api/jobs/:id/resume', ctx => {
  const old = jobs.get(ctx.params.id);
  if (!old) return json(ctx.res, { error: 'not found' }, 404);
  if (old.kind !== 'import') return json(ctx.res, { error: '仅支持导入任务续跑' }, 400);
  const cursor = old.cursor ?? 0;
  const workId = old.result?.workId;
  if (!workId || !cursor) return json(ctx.res, { error: '该任务没有可续跑的游标（未处理过任何章节）' }, 409);
  const running = jobs.list().find(j => j.kind === 'import' && j.worldId === old.worldId && (j.status === 'queued' || j.status === 'running'));
  if (running) return json(ctx.res, { error: `已有进行中的导入任务 ${running.id}` }, 409);
  const b = ctx.body ?? {};
  // 优先用请求携带的原文；否则读导入时持久化的副本（免手工重传）
  let text = String(b.text ?? '');
  if (!text) {
    const savedPath = join(DATA_DIR, 'imports', `${ctx.params.id}.json`);
    if (existsSync(savedPath)) {
      const saved = JSON.parse(readFileSync(savedPath, 'utf8'));
      text = String(saved.text ?? '');
      b.title = b.title || saved.title;
      b.baseYear = b.baseYear ?? saved.baseYear;
      b.llmChapterBudget = b.llmChapterBudget ?? saved.llmChapterBudget;
    }
  }
  if (!text) return json(ctx.res, { error: 'resume 需原文（请求携带 text 或导入时已持久化）' }, 400);
  const job = jobs.create('import', { worldId: old.worldId, label: `续跑：${old.label}` });
  json(ctx.res, { jobId: job.id, cursor, workId }, 202);
  importNovel(store, ws, jobs, {
    worldId: old.worldId!, workTitle: b.title || old.label.replace(/^拆书：/, ''), text: String(b.text),
    baseYear: b.baseYear != null ? Number(b.baseYear) : undefined,
    extractorProvider: ws.providerFor('extractor'), fallbackExtractorProvider: ws.providerFor('chat'), chatProvider: ws.providerFor('chat'), adversarialProvider: ws.providerFor('adversarial'),
    llmChapterBudget: b.llmChapterBudget != null ? Number(b.llmChapterBudget) : undefined,
    jobId: job.id, resume: { workId, cursor },
  }).catch(() => { /* job 已记录错误 */ });
});

// worlds
route('GET', '/api/worlds', ctx => json(ctx.res, store.listWorlds()));
route('POST', '/api/worlds', ctx => {
  const id = ctx.body.id || newId('world');
  store.createWorld(id, ctx.body.title || '新世界');
  json(ctx.res, { id, title: ctx.body.title }, 201);
});
route('GET', '/api/worlds/:id/state', ctx => {
  const at = ctx.query.get('at');
  json(ctx.res, store.stateAt(ctx.params.id, at != null ? { worldTime: Number(at) } : undefined));
});
route('GET', '/api/worlds/:id/visible-state', ctx => {
  const viewer = ctx.query.get('viewer') ?? '';
  const at = ctx.query.get('at');
  json(ctx.res, store.stateVisibleTo(ctx.params.id, viewer, at != null ? { worldTime: Number(at) } : undefined));
});
route('GET', '/api/worlds/:id/timeline', ctx => json(ctx.res, store.timeline(ctx.params.id)));
route('GET', '/api/worlds/:id/events', ctx => {
  const { fromSeq, toSeq, kind } = Object.fromEntries(ctx.query as any);
  json(ctx.res, store.listEvents(ctx.params.id, {
    fromSeq: fromSeq != null ? Number(fromSeq) : undefined,
    toSeq: toSeq != null ? Number(toSeq) : undefined,
    kind: kind ?? undefined,
  }));
});
route('GET', '/api/worlds/:id/diff', ctx => {
  const from = ctx.query.get('from');
  const to = ctx.query.get('to');
  json(ctx.res, store.diff(ctx.params.id, { worldTime: from != null ? Number(from) : undefined }, { worldTime: to != null ? Number(to) : undefined }));
});
route('POST', '/api/worlds/:id/branch', ctx => {
  const id = newId('world');
  const fromSeq = ctx.body.fromSeq != null ? Number(ctx.body.fromSeq) : undefined;
  const r = store.branchWorld(ctx.params.id, id, ctx.body.title || '世界线分支', fromSeq);
  json(ctx.res, { id, ...r }, 201);
});
route('GET', '/api/worlds/:id/usage', ctx => json(ctx.res, store.usageReport(ctx.params.id)));

// 手工事件（作者级直接入库）
route('POST', '/api/events', ctx => {
  const b = ctx.body;
  const input: NewEventInput = { ...b, actor: b.actor ?? 'author', review: { status: 'approved', by: 'author' } };
  const e = store.append(input);
  json(ctx.res, e, 201);
});
route('POST', '/api/events/:id/rollback', ctx => {
  const e = store.rollback(ctx.params.id, ctx.body.reason);
  json(ctx.res, { ok: !!e, event: e ?? null });
});

// works / chapters
route('GET', '/api/works', ctx => json(ctx.res, store.listWorks(ctx.query.get('worldId') ?? undefined)));
route('POST', '/api/works', ctx => {
  const id = newId('work');
  store.createWork({ id, worldId: ctx.body.worldId, title: ctx.body.title || '无题', author: ctx.body.author, description: ctx.body.description, createdAt: new Date().toISOString() });
  json(ctx.res, { id }, 201);
});
route('PATCH', '/api/works/:id', ctx => { store.updateWork(ctx.params.id, ctx.body); json(ctx.res, { ok: true }); });
route('DELETE', '/api/works/:id', ctx => { store.deleteWork(ctx.params.id); ws.deleteWorkDir(ctx.params.id); json(ctx.res, { ok: true }); });
route('GET', '/api/works/:id/chapters', ctx => json(ctx.res, store.listChapters(ctx.params.id)));
route('POST', '/api/works/:id/chapters', ctx => {
  const work = store.getWork(ctx.params.id);
  if (!work) return json(ctx.res, { error: 'work not found' }, 404);
  const id = newId('ch');
  const index = store.listChapters(work.id).length;
  const worldTime = Number(ctx.body.worldTime ?? 1000);
  store.saveChapter({ id, workId: work.id, title: ctx.body.title || `第${index + 1}章`, index, worldTime, worldTimeLabel: timeLabel(worldTime), kind: 'body' });
  if (ctx.body.body) ws.writeChapterBody(work.id, id, ctx.body.body);
  json(ctx.res, { id }, 201);
});
route('GET', '/api/chapters/:id', ctx => {
  const c = store.getChapter(ctx.params.id);
  if (!c) return json(ctx.res, { error: 'not found' }, 404);
  json(ctx.res, { ...c, body: ws.readChapterBody(c.workId, c.id) });
});
route('PUT', '/api/chapters/:id', ctx => {
  const c = store.getChapter(ctx.params.id);
  if (!c) return json(ctx.res, { error: 'not found' }, 404);
  const title = ctx.body.title ?? c.title;
  const worldTime = ctx.body.worldTime != null ? Number(ctx.body.worldTime) : c.worldTime;
  let body = ws.readChapterBody(c.workId, c.id) ?? '';
  if (ctx.body.body != null) { body = ctx.body.body; ws.writeChapterBody(c.workId, c.id, body); }
  store.saveChapter({ ...c, title, worldTime, worldTimeLabel: timeLabel(worldTime), wordCount: body.length });
  json(ctx.res, { ok: true });
});
route('DELETE', '/api/chapters/:id', ctx => {
  const c = store.getChapter(ctx.params.id);
  if (!c) return json(ctx.res, { error: 'not found' }, 404);
  store.deleteChapter(c.id); ws.deleteChapterBody(c.workId, c.id);
  json(ctx.res, { ok: true });
});
// 定稿 + 手改同步（MD 2.3）
route('POST', '/api/works/:id/finalize', async ctx => {
  const work = store.getWork(ctx.params.id);
  const b = ctx.body;
  sseInit(ctx.res);
  const r = await finalizeChapter(deps, work!.worldId, work!.id, b.chapterId, b.title, b.index ?? 0, b.worldTime ?? 1000, b.body ?? '', e => sseSend(ctx.res, e.type, e.data ?? {}));
  sseSend(ctx.res, 'done', r);
  ctx.res.end();
});

// proposals（审核队列）
route('GET', '/api/worlds/:id/proposals', ctx => json(ctx.res, store.listProposals(ctx.params.id, ctx.query.get('status') ?? undefined)));
/** 单条批准（含乐观锁引用重校验 + 按需建册）；单条路由与批量审核共用 */
function approveChecked(p: import('@eventverse/core').Proposal): { ok: boolean; applied: number; reason?: string } {
  if (p.baseSeq != null) {
    const cur = (store.db.prepare('SELECT MAX(sequence) AS m FROM events WHERE world_id=?').get(p.worldId) as any)?.m ?? 0;
    if (cur > p.baseSeq) {
      const { events } = normalizeRefs(store, p.worldId, (p.events as any[]).map((e: any) => ({
        worldId: e.worldId, workId: e.workId, worldTime: e.worldTime, actor: 'agent' as const,
        kind: e.kind, payload: e.payload, visibility: e.visibility,
      })));
      // 按需建册：关系/移动引用了未登记角色 → 先补人物 stub（跨章时序的常见情况，关系有效性优先）
      const st0 = store.stateAt(p.worldId);
      const known = new Set<string>([...Object.keys(st0.characters)]);
      for (const e of events) if (e.kind === 'char.create') known.add(String((e.payload as any)?.id ?? (e.payload as any)?.name ?? ''));
      const stubs: any[] = [];
      for (const e of events) {
        const p2: any = e.payload ?? {};
        for (const n of [p2.from, p2.to, p2.charId]) {
          if (typeof n === 'string' && n && !known.has(n)) {
            known.add(n);
            stubs.push({ worldId: e.worldId, workId: e.workId, worldTime: e.worldTime, actor: 'agent', kind: 'char.create', payload: { id: n, name: n, attrs: { 来源: '按需建册' } }, visibility: e.visibility ?? { knowers: '*', scope: 'public' } });
          }
        }
      }
      if (stubs.length) (p.events as any[]).unshift(...stubs);
      const recheck = autoValidate(store, p.worldId, (p.events as any[]).map((e: any) => ({
        worldId: e.worldId, workId: e.workId, worldTime: e.worldTime, actor: 'agent' as const,
        kind: e.kind, payload: e.payload, visibility: e.visibility,
      })));
      if (!recheck.ok) return { ok: false, applied: 0, reason: 'stale-conflict' };
      if (stubs.length) store.saveProposal({ ...p, events: p.events });
    }
  }
  store.setProposalStatus(p.id, 'approved');
  const applied = store.applyProposal(p.id);
  return { ok: true, applied: applied.length };
}

route('POST', '/api/proposals/:id/approve', ctx => {
  const p = store.getProposal(ctx.params.id);
  if (!p) return json(ctx.res, { error: 'not found' }, 404);
  const r = approveChecked(p);
  if (!r.ok) return json(ctx.res, { error: '世界状态已变化，提案与新状态冲突，请重新处理', reason: r.reason }, 409);
  json(ctx.res, { ok: true, applied: r.applied });
});
route('POST', '/api/proposals/:id/reject', ctx => { store.setProposalStatus(ctx.params.id, 'rejected'); json(ctx.res, { ok: true }); });
// 批量审核（一键处理全部待审；批准复用单条同一套引用重校验，坏引用自动跳过）
route('POST', '/api/worlds/:id/proposals/batch', ctx => {
  const action = ctx.body.action === 'reject' ? 'rejected' : 'approved';
  const pend = store.listProposals(ctx.params.id, 'pending');
  let done = 0, applied = 0, skipped = 0;
  for (const p of pend) {
    if (action === 'rejected') { store.setProposalStatus(p.id, 'rejected'); done++; continue; }
    const r = approveChecked(p);
    if (r.ok) { done++; applied += r.applied; } else skipped++;
  }
  json(ctx.res, { ok: true, action, proposals: done, eventsApplied: applied, skipped });
});

// guidance
route('GET', '/api/worlds/:id/guidance', ctx => json(ctx.res, store.listGuidance(ctx.params.id)));
route('POST', '/api/worlds/:id/guidance', ctx => {
  const g = store.addGuidance({ ...ctx.body, worldId: ctx.params.id, source: ctx.body.source ?? 'author', active: true } as any);
  json(ctx.res, g, 201);
});
route('PATCH', '/api/guidance/:id', ctx => { store.setGuidanceActive(ctx.params.id, !!ctx.body.active); json(ctx.res, { ok: true }); });

// sessions
route('GET', '/api/sessions', ctx => json(ctx.res, ws.listSessions(ctx.query.get('worldId') ?? undefined).map(s => ({ ...s, turns: undefined, turnCount: s.turns.length }))));
route('POST', '/api/sessions', ctx => {
  const b = ctx.body;
  let profile = b.profile;
  // 内容分级三方取小（MD 5.1）：min(user, pack, global)，创建时算死写入
  if (b.mode !== 'write') {
    let packTier: string | undefined;
    if (b.packId) {
      const pk = packs.get(b.packId);
      if (pk) {
        const progress = packs.startProgress(pk, b.entryRole ?? 'protagonist', { playMode: b.playMode, rewriteIntensity: b.rewriteIntensity, metaKnowledge: b.metaKnowledge });
        profile = { ...(profile ?? {}), pack: progress };
        packTier = (pk as any).contentTier;
      }
    }
    profile = { charId: null, focusCharId: null, ...(profile ?? {}), contentTier: store.resolveTier(b.contentTier, packTier, b.worldId) };
  }
  const s = ws.newSession(b.worldId, b.mode ?? 'rp', b.title || '新会话', b.workId ?? null, profile);
  json(ctx.res, s, 201);
});
route('GET', '/api/sessions/:id', ctx => { const s = ws.getSession(ctx.params.id); s ? json(ctx.res, s) : json(ctx.res, { error: 'not found' }, 404); });
route('DELETE', '/api/sessions/:id', ctx => { ws.deleteSession(ctx.params.id); json(ctx.res, { ok: true }); });

// packs（玩侧剧本包）
route('GET', '/api/packs', ctx => {
  const list = packs.list(ctx.query.get('worldId') ?? undefined);
  json(ctx.res, list.map(p => ({ ...p, playable: packPlayable(p) })));
});
route('GET', '/api/packs/:id', ctx => { const p = packs.get(ctx.params.id); p ? json(ctx.res, p) : json(ctx.res, { error: 'not found' }, 404); });
route('POST', '/api/packs', ctx => {
  const b = ctx.body;
  const p: StoryPack = { ...(b.pack ?? {}), id: b.pack?.id ?? newPackId(), worldId: b.worldId, createdAt: new Date().toISOString() };
  packs.save(p);
  json(ctx.res, p, 201);
});
route('DELETE', '/api/packs/:id', ctx => { packs.delete(ctx.params.id); json(ctx.res, { ok: true }); });
route('POST', '/api/packs/:id/start', ctx => {
  const p = packs.get(ctx.params.id);
  if (!p) return json(ctx.res, { error: 'not found' }, 404);
  const progress = packs.startProgress(p, ctx.body.entryRole ?? 'protagonist', ctx.body);
  const profile = {
    charId: ctx.body.charId ?? p.characters[0] ?? null,
    focusCharId: null as string | null,
    contentTier: store.resolveTier(ctx.body.contentTier, (p as any).contentTier, p.worldId),
    pack: progress,
  };
  const s = ws.newSession(p.worldId, 'rp', `🎮 ${p.title}`, null, profile);
  json(ctx.res, s, 201);
});
route('PATCH', '/api/worlds/:id/tier', ctx => { store.setWorldMaxTier(ctx.params.id, ctx.body.maxTier); json(ctx.res, { ok: true }); });

// 元层自进化（MD 3.5：LLM 依据 Guidance 提案 prompt 覆盖，人工批准，链式可回滚）
route('POST', '/api/worlds/:id/evolve', async ctx => {
  const worldId = ctx.params.id;
  const guidance = store.listGuidance(worldId).filter(g => g.active);
  const recent = store.listProposals(worldId).slice(0, 10);
  const p = ws.providerFor('director');
  sseInit(ctx.res);
  try {
    const res = await callLLM(p, [
      { role: 'system', content: `你是元层自进化审阅员。只能提出对【抽取器提示词】的微调（更严格的抽取纪律、更精准的格式要求），禁止改动剧情、角色事实或用户品味。输出 JSON：{"reason":"...","patch":"要追加到抽取器 system prompt 末尾的一段指令（<=120字）","serves":"服务的 guidance 标题"}` },
      { role: 'user', content: `当前抽取器 system prompt 末尾：\n（见附）\n\nGuidance：\n${guidance.map(g => `- ${g.title}：${g.description}`).join('\n') || '（无）'}\n\n最近提案样本：\n${recent.map(r => `${r.status} ${r.autoCheck.ok ? '校验过' : '校验失败:' + r.autoCheck.issues.join(';')}`).join('\n') || '（无）'}` },
    ], { temperature: 0.4, maxTokens: 400 });
    const j = extractJson(res.content);
    if (!j?.patch) { sseSend(ctx.res, 'error', { message: '未产出有效 patch' }); ctx.res.end(); return; }
    sseSend(ctx.res, 'evolve_proposal', { reason: j.reason, patch: j.patch, serves: j.serves });
    if (ctx.body.autoApply) {
      // 回归门（MD §9.3）：覆盖前后各跑固定题库，退化则拒绝应用
      const current = store.latestPromptOverride(worldId, 'extractor');
      const gate = await regressionGate(p, current, String(j.patch));
      sseSend(ctx.res, 'regression_gate', gate);
      if (!gate.pass) {
        sseSend(ctx.res, 'error', { message: `回归门未通过（题库得分 ${gate.before} → ${gate.after}），已自动拒绝应用` });
        return void ctx.res.end();
      }
      const r = store.savePromptOverride(worldId, 'extractor', String(j.patch));
      store.append({ worldId, actor: 'system', kind: 'meta.note', meta: true, worldTime: store.stateAt(worldId).asOf.worldTime === -Infinity ? 1000 : store.stateAt(worldId).asOf.worldTime, payload: { text: `元层自进化：追加抽取器覆盖（服务 ${j.serves ?? '未注明'}）` }, review: { status: 'approved', by: 'evolve' } });
      sseSend(ctx.res, 'applied', r);
    }
  } catch (e: any) { sseSend(ctx.res, 'error', { message: String(e?.message ?? e) }); }
  ctx.res.end();
});
route('GET', '/api/worlds/:id/evolve/history', ctx => json(ctx.res, store.promptOverrideHistory(ctx.params.id)));
route('POST', '/api/evolve/:overrideId/rollback', ctx => {
  const ok = store.rollbackPromptOverride(ctx.params.overrideId);
  json(ctx.res, { ok });
});

// RP 回合（SSE）
route('POST', '/api/sessions/:id/turn', async ctx => {
  const s = ws.getSession(ctx.params.id);
  if (!s) return json(ctx.res, { error: 'not found' }, 404);
  sseInit(ctx.res);
  try {
    await runRpTurn(deps, s, String(ctx.body.message ?? ''), e => sseSend(ctx.res, e.type, e.data ?? {}), { optionIndex: ctx.body.optionIndex });
  } catch (e: any) {
    sseSend(ctx.res, 'error', { message: String(e?.message ?? e) });
  }
  ctx.res.end();
});

// 写作模式（SSE）：大纲 → beat → 草稿
route('POST', '/api/sessions/:id/write-draft', async ctx => {
  const s = ws.getSession(ctx.params.id);
  if (!s) return json(ctx.res, { error: 'not found' }, 404);
  sseInit(ctx.res);
  try {
    await runWriteDraft(deps, s, String(ctx.body.outline ?? ''), String(ctx.body.chapterTitle ?? '新章'), e => sseSend(ctx.res, e.type, e.data ?? {}));
  } catch (e: any) { sseSend(ctx.res, 'error', { message: String(e?.message ?? e) }); }
  ctx.res.end();
});

// 圈改重写（SSE）
route('POST', '/api/sessions/:id/rewrite', async ctx => {
  const s = ws.getSession(ctx.params.id);
  if (!s) return json(ctx.res, { error: 'not found' }, 404);
  sseInit(ctx.res);
  try {
    const out = await rewriteSelection(deps, s, String(ctx.body.draft ?? ''), String(ctx.body.selection ?? ''), String(ctx.body.instruction ?? ''), e => sseSend(ctx.res, e.type, e.data ?? {}));
    sseSend(ctx.res, 'full', { text: out });
  } catch (e: any) { sseSend(ctx.res, 'error', { message: String(e?.message ?? e) }); }
  ctx.res.end();
});

// 删除世界（级联：事件/提案/Guidance/作品/章节）
route('DELETE', '/api/worlds/:id', ctx => {
  const id = ctx.params.id;
  if (id === 'demo') return json(ctx.res, { error: '演示世界不可删除' }, 403);
  for (const w of store.listWorks(id)) ws.deleteWorkDir(w.id);
  store.deleteWorldCascade(id);
  json(ctx.res, { ok: true });
});

// 带工具对话（读侧自由，agent loop）
route('POST', '/api/chat', async ctx => {
  sseInit(ctx.res);
  const chatWorldId = ctx.body.worldId;
  const worldTitle = store.listWorlds().find(w => w.id === chatWorldId)?.title ?? chatWorldId;
  const toolCtx: ToolContext = {
    store, ws, worldId: chatWorldId, workId: ctx.body.workId ?? null,
    viewerCharId: ctx.body.viewerCharId ?? null,
    adversarialProvider: deps.adversarialProvider(), sourceLabel: 'chat',
  };
  try {
    const history = ((ctx.body.history ?? []) as any[]).map(h => ({ role: h.role ?? 'user', content: String(h.content ?? '') }));
    const system = `你是「事界」的世界问答助手，当前管理的世界：《${worldTitle}》。\n你拥有查询这个世界真实事实的工具：story_index（章节结构）、read_chapters（读正文）、grep（关键词检索）、search_entities（人物/关系/设定/伏笔检索）、recall（角色视角）。\n规则：回答前先调用工具检索依据；人名关系等一律以工具结果为准，不要凭空编造；用中文回答。`;
    await runToolChat(deps, toolCtx, [{ role: 'system', content: system }, ...history, { role: 'user', content: String(ctx.body.message ?? '') }], e => sseSend(ctx.res, e.type, e.data ?? {}));
  } catch (e: any) { sseSend(ctx.res, 'error', { message: String(e?.message ?? e) }); }
  ctx.res.end();
});

// 拆书导入（Job；同世界写锁——并发导入返回 409，MD 2.4）
route('POST', '/api/import', async ctx => {
  const worldId = String(ctx.body.worldId ?? '');
  if (!worldId) return json(ctx.res, { error: 'worldId required' }, 400);
  const text = String(ctx.body.text ?? '');
  const bad = (text.match(/\uFFFD/g) || []).length;
  if (bad > text.length * 0.005) {
    return json(ctx.res, { error: `文本含 ${bad} 处乱码（疑似 GBK 编码被按 UTF-8 读取）。请用书架页的"选择 TXT 文件"上传（自动识别编码），或重新以 UTF-8 粘贴。` }, 400);
  }
  const running = jobs.list().find(j => j.kind === 'import' && j.worldId === worldId && (j.status === 'queued' || j.status === 'running'));
  if (running) return json(ctx.res, { error: `该世界已有进行中的导入任务 ${running.id}`, jobId: running.id }, 409);
  const job = jobs.create('import', { worldId, label: `拆书：${ctx.body.title ?? ''}` });
  // 持久化导入原文：断点续跑免手工重传（MD §2.4）
  try {
    mkdirSync(join(DATA_DIR, 'imports'), { recursive: true });
    writeFileSync(join(DATA_DIR, 'imports', `${job.id}.json`), JSON.stringify({
      worldId, title: ctx.body.title ?? '', text: String(ctx.body.text ?? ''),
      baseYear: ctx.body.baseYear, llmChapterBudget: ctx.body.llmChapterBudget,
    }), 'utf8');
  } catch { /* 持久化失败不阻断导入 */ }
  json(ctx.res, { jobId: job.id }, 202);
  importNovel(store, ws, jobs, {
    worldId, workTitle: ctx.body.title || '导入作品', text: String(ctx.body.text ?? ''),
    baseYear: ctx.body.baseYear != null ? Number(ctx.body.baseYear) : undefined,
    extractorProvider: ws.providerFor('extractor'), fallbackExtractorProvider: ws.providerFor('chat'), chatProvider: ws.providerFor('chat'), adversarialProvider: ws.providerFor('adversarial'),
    llmChapterBudget: ctx.body.llmChapterBudget != null ? Number(ctx.body.llmChapterBudget) : undefined,
    jobId: job.id,
  }).catch(() => { /* job 已记录错误 */ });
});

// ST 卡导入：JSON 或 PNG base64
route('POST', '/api/import/st-card', ctx => {
  const worldId = String(ctx.body.worldId ?? '');
  let card = null;
  if (ctx.body.pngBase64) {
    const buf = Buffer.from(String(ctx.body.pngBase64), 'base64');
    card = extractCardFromPng(new Uint8Array(buf));
  } else if (ctx.body.card) {
    card = parseSTCard(ctx.body.card);
  }
  if (!card?.data?.name) return json(ctx.res, { error: '无法解析角色卡' }, 400);
  const d = card.data;
  const id = newId('char');
  const events: NewEventInput[] = [{
    worldId, actor: 'author', worldTime: Number(ctx.body.worldTime ?? 1000), kind: 'char.create',
    payload: { id, name: d.name, gender: undefined, attrs: { 描述: (d.description ?? '').slice(0, 500), 性格: (d.personality ?? '').slice(0, 200), 场景: (d.scenario ?? '').slice(0, 200) } },
    review: { status: 'approved', by: 'st-import' }, sourceRef: 'st-card',
  }];
  const applied = events.map(e => store.append(e));
  // 世界书随卡导入 → fact.set
  let facts = 0;
  for (const entry of normalizeWorldBook(d.character_book)) {
    if (!entry.enabled || !entry.content) continue;
    store.append({ worldId, actor: 'author', worldTime: Number(ctx.body.worldTime ?? 1000), kind: 'fact.set', payload: { key: `lore:${entry.keys[0] ?? '条目'}`, value: entry.content.slice(0, 1000), validFrom: 1000 }, review: { status: 'approved' }, sourceRef: 'st-card' });
    facts++;
  }
  json(ctx.res, { ok: true, charId: id, name: d.name, facts, events: applied.length }, 201);
});

// 世界书导出
route('GET', '/api/worlds/:id/export/worldbook', ctx => {
  const state = store.stateAt(ctx.params.id);
  const wb = exportWorldBookFromFacts(state.facts.map(f => ({ key: f.key, value: f.value })), `eventverse-${ctx.params.id}`);
  json(ctx.res, wb);
});

// jobs
route('GET', '/api/jobs', ctx => json(ctx.res, jobs.list()));
route('GET', '/api/jobs/:id', ctx => { const j = jobs.get(ctx.params.id); j ? json(ctx.res, j) : json(ctx.res, { error: 'not found' }, 404); });
route('POST', '/api/jobs/:id/cancel', ctx => { jobs.cancel(ctx.params.id); json(ctx.res, { ok: true }); });
route('GET', '/api/jobs/:id/stream', ctx => {
  const j = jobs.get(ctx.params.id);
  if (!j) return json(ctx.res, { error: 'not found' }, 404);
  sseInit(ctx.res);
  sseSend(ctx.res, 'job', j);
  if (j.status === 'done' || j.status === 'error' || j.status === 'cancelled') { ctx.res.end(); return; }
  const unsub = jobs.subscribe(ctx.params.id, job => {
    sseSend(ctx.res, 'job', job);
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') { unsub(); ctx.res.end(); }
  });
  ctx.req.on('close', unsub);
});

// settings（密钥不回传）
route('GET', '/api/settings', ctx => {
  const list = ws.loadProviders();
  json(ctx.res, { providers: list.map(p => ({ ...p, apiKey: undefined, hasKey: !!p.apiKey, configured: p.protocol !== 'mock' })) });
});
route('PUT', '/api/settings', ctx => {
  const incoming: ProviderConfig[] = ctx.body.providers ?? [];
  const existing = ws.loadProviders();
  const merged = incoming.map(p => {
    const old = existing.find(e => e.id === p.id);
    return { ...p, apiKey: p.apiKey || old?.apiKey || '' };
  });
  ws.saveProviders(merged);
  json(ctx.res, { ok: true });
});

server.listen(PORT, HOST, () => {
  console.log(`EventVerse server → http://${HOST}:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
  console.log(`Web UI：${existsSync(WEB_DIST) ? `http://${HOST}:${PORT}/` : '（未构建 web，运行 npm run build -w @eventverse/web）'}`);
});
