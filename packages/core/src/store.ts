// 事件库：node:sqlite 存储 + append-only + 回滚 + 分支（MD 1.4 / 2.4）
import { DatabaseSync } from 'node:sqlite';
import {
  WorldEvent, WorldState, Guidance, Proposal, WorkMeta, ChapterMeta,
  SCHEMA_VER, Actor, ReviewStatus, Visibility,
} from './types.js';
import { replay, replayVisible, diffStates, StateDiff, isEmptyDiff } from './reducer.js';
import { randomUUID } from 'node:crypto';

export interface NewEventInput {
  worldId: string;
  workId?: string | null;
  worldTime: number;
  worldTimeLabel?: string;
  chapterRef?: string | null;
  turnRef?: string | null;
  actor: Actor;
  kind: WorldEvent['kind'];
  payload: any;
  visibility?: Visibility;
  review?: { status: ReviewStatus; by?: string; confidence?: number };
  sourceRef?: string | null;
  meta?: boolean;
}

const META_KINDS = new Set(['intent.set', 'meta.rollback', 'meta.note']);

export class EventStore {
  db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.init();
  }

  private init() {
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS worlds (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, title TEXT NOT NULL, author TEXT, description TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, schema_ver INTEGER NOT NULL, sequence INTEGER NOT NULL,
      world_id TEXT NOT NULL, work_id TEXT, world_time REAL NOT NULL, world_time_label TEXT,
      chapter_ref TEXT, turn_ref TEXT, actor TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, visibility TEXT NOT NULL, review TEXT NOT NULL,
      superseded_by TEXT, source_ref TEXT, meta INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_world_seq ON events(world_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_events_world_time ON events(world_id, world_time);
    CREATE TABLE IF NOT EXISTS guidance (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, source TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, world_id TEXT NOT NULL, events TEXT NOT NULL, auto_check TEXT NOT NULL, adversarial TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, source_label TEXT);
    CREATE TABLE IF NOT EXISTS usage_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, world_id TEXT, role TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, label TEXT);
    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL, title TEXT NOT NULL, idx INTEGER NOT NULL,
      world_time REAL NOT NULL DEFAULT 0, world_time_label TEXT, kind TEXT NOT NULL DEFAULT 'body', word_count INTEGER DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id, idx);
    CREATE TABLE IF NOT EXISTS prompt_overrides (
      id TEXT PRIMARY KEY, world_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
      prev_id TEXT, created_at TEXT NOT NULL
    );
    `);
    try { this.db.exec('ALTER TABLE worlds ADD COLUMN max_tier TEXT NOT NULL DEFAULT \'open\''); } catch { /* 已存在 */ }
    try { this.db.exec('ALTER TABLE proposals ADD COLUMN base_seq INTEGER'); } catch { /* 已存在 */ }
    this.db.exec(`CREATE TABLE IF NOT EXISTS cost_baseline (
      world_id TEXT NOT NULL, role TEXT NOT NULL, avg_in INTEGER NOT NULL, avg_out INTEGER NOT NULL,
      calls INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (world_id, role)
    );`);
  }

  close() { this.db.close(); }

  // ---------- worlds / works ----------

  createWorld(id: string, title: string) {
    this.db.prepare('INSERT OR REPLACE INTO worlds (id, title, created_at) VALUES (?,?,?)')
      .run(id, title, new Date().toISOString());
  }
  listWorlds() {
    return this.db.prepare('SELECT id, title, created_at FROM worlds ORDER BY created_at').all() as any[];
  }
  createWork(w: WorkMeta) {
    this.db.prepare('INSERT INTO works (id, world_id, title, author, description, created_at) VALUES (?,?,?,?,?,?)')
      .run(w.id, w.worldId, w.title, w.author ?? null, w.description ?? null, w.createdAt);
  }
  updateWork(id: string, patch: { title?: string; author?: string; description?: string }) {
    const w = this.getWork(id); if (!w) return;
    this.db.prepare('UPDATE works SET title=?, author=?, description=? WHERE id=?')
      .run(patch.title ?? w.title, patch.author ?? w.author ?? null, patch.description ?? w.description ?? null, id);
  }
  deleteWork(id: string) { this.db.prepare('DELETE FROM works WHERE id=?').run(id); }
  getWork(id: string): WorkMeta | undefined {
    const r = this.db.prepare('SELECT * FROM works WHERE id=?').get(id) as any;
    if (!r) return undefined;
    return { id: r.id, worldId: r.world_id, title: r.title, author: r.author ?? undefined, description: r.description ?? undefined, createdAt: r.created_at };
  }
  listWorks(worldId?: string): WorkMeta[] {
    const rows = worldId
      ? this.db.prepare('SELECT * FROM works WHERE world_id=? ORDER BY created_at').all(worldId)
      : this.db.prepare('SELECT * FROM works ORDER BY created_at').all();
    return (rows as any[]).map(r => ({ id: r.id, worldId: r.world_id, title: r.title, author: r.author ?? undefined, description: r.description ?? undefined, createdAt: r.created_at }));
  }

  // ---------- chapters（元数据入库；正文是 Markdown 文件，由 server 管理，MD 1.4） ----------

  saveChapter(c: ChapterMeta): ChapterMeta {
    const now = new Date().toISOString();
    const exists = this.db.prepare('SELECT id FROM chapters WHERE id=?').get(c.id);
    if (exists) {
      this.db.prepare('UPDATE chapters SET title=?, idx=?, world_time=?, world_time_label=?, kind=?, word_count=?, updated_at=? WHERE id=?')
        .run(c.title, c.index, c.worldTime, c.worldTimeLabel ?? null, c.kind, c.wordCount ?? 0, now, c.id);
    } else {
      this.db.prepare('INSERT INTO chapters (id, work_id, title, idx, world_time, world_time_label, kind, word_count, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(c.id, c.workId, c.title, c.index, c.worldTime, c.worldTimeLabel ?? null, c.kind, c.wordCount ?? 0, now, now);
    }
    return c;
  }
  listChapters(workId: string): ChapterMeta[] {
    const rows = this.db.prepare('SELECT * FROM chapters WHERE work_id=? ORDER BY idx').all(workId) as any[];
    return rows.map(r => ({ id: r.id, workId: r.work_id, title: r.title, index: r.idx, worldTime: r.world_time, worldTimeLabel: r.world_time_label ?? undefined, kind: r.kind, wordCount: r.word_count }));
  }
  getChapter(id: string): ChapterMeta | undefined {
    const r = this.db.prepare('SELECT * FROM chapters WHERE id=?').get(id) as any;
    if (!r) return undefined;
    return { id: r.id, workId: r.work_id, title: r.title, index: r.idx, worldTime: r.world_time, worldTimeLabel: r.world_time_label ?? undefined, kind: r.kind, wordCount: r.word_count };
  }
  deleteChapter(id: string) { this.db.prepare('DELETE FROM chapters WHERE id=?').run(id); }

  // ---------- events ----------

  append(input: NewEventInput): WorldEvent {
    const seq = this.nextSequence(input.worldId);
    const e: WorldEvent = {
      schemaVer: SCHEMA_VER, id: randomUUID(), sequence: seq,
      worldId: input.worldId, workId: input.workId ?? null,
      worldTime: input.worldTime, worldTimeLabel: input.worldTimeLabel,
      chapterRef: input.chapterRef ?? null, turnRef: input.turnRef ?? null,
      actor: input.actor, kind: input.kind, payload: input.payload,
      visibility: input.visibility ?? { knowers: '*', scope: 'public' },
      review: input.review ?? { status: input.actor === 'author' ? 'approved' : 'auto_ok' },
      supersededBy: null, sourceRef: input.sourceRef ?? null,
      createdAt: new Date().toISOString(),
      meta: input.meta ?? META_KINDS.has(input.kind as string),
    };
    this.db.prepare(`INSERT INTO events (id,schema_ver,sequence,world_id,work_id,world_time,world_time_label,chapter_ref,turn_ref,actor,kind,payload,visibility,review,superseded_by,source_ref,meta,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.id, e.schemaVer, e.sequence, e.worldId, e.workId, e.worldTime, e.worldTimeLabel ?? null,
        e.chapterRef ?? null, e.turnRef ?? null, e.actor, e.kind, JSON.stringify(e.payload), JSON.stringify(e.visibility),
        JSON.stringify(e.review), null, e.sourceRef ?? null, e.meta ? 1 : 0, e.createdAt);
    return e;
  }

  private nextSequence(worldId: string): number {
    const r = this.db.prepare('SELECT MAX(sequence) AS m FROM events WHERE world_id=?').get(worldId) as any;
    return (r?.m ?? 0) + 1;
  }

  listEvents(worldId: string, opts: { fromSeq?: number; toSeq?: number; kind?: string } = {}): WorldEvent[] {
    const conds = ['world_id=?']; const args: any[] = [worldId];
    if (opts.fromSeq != null) { conds.push('sequence>=?'); args.push(opts.fromSeq); }
    if (opts.toSeq != null) { conds.push('sequence<=?'); args.push(opts.toSeq); }
    if (opts.kind) { conds.push('kind=?'); args.push(opts.kind); }
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${conds.join(' AND ')} ORDER BY sequence`).all(...args) as any[];
    return rows.map(rowToEvent);
  }

  getEvent(id: string): WorldEvent | undefined {
    const r = this.db.prepare('SELECT * FROM events WHERE id=?').get(id) as any;
    return r ? rowToEvent(r) : undefined;
  }

  /** 回滚：标记被推翻 + 追加审计事件（永不物理删除，MD 1.2） */
  rollback(targetId: string, reason?: string): WorldEvent | undefined {
    const t = this.getEvent(targetId);
    if (!t || t.supersededBy) return undefined;
    const audit = this.append({
      worldId: t.worldId, workId: t.workId, worldTime: t.worldTime,
      actor: 'author', kind: 'meta.rollback', meta: true,
      payload: { targetEventId: targetId, reason },
      review: { status: 'approved', by: 'rollback' },
      sourceRef: 'rollback',
    });
    this.db.prepare('UPDATE events SET superseded_by=? WHERE id=?').run(audit.id, targetId);
    return audit;
  }

  /** 世界线分支：复制 fromSeq 及之前的事件到新 world（梨园存档/回档的通用底座） */
  branchWorld(fromWorldId: string, newWorldId: string, newTitle: string, fromSeq?: number): { copied: number } {
    const upto = fromSeq ?? Number.MAX_SAFE_INTEGER;
    const events = this.listEvents(fromWorldId, { toSeq: upto });
    this.createWorld(newWorldId, newTitle);
    let seq = 0;
    const ins = this.db.prepare(`INSERT INTO events (id,schema_ver,sequence,world_id,work_id,world_time,world_time_label,chapter_ref,turn_ref,actor,kind,payload,visibility,review,superseded_by,source_ref,meta,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const e of events) {
      seq += 1;
      ins.run(randomUUID(), e.schemaVer, seq, newWorldId, e.workId, e.worldTime, e.worldTimeLabel ?? null,
        e.chapterRef ?? null, e.turnRef ?? null, e.actor, e.kind, JSON.stringify(e.payload), JSON.stringify(e.visibility),
        JSON.stringify(e.review), e.supersededBy ?? null, `branch-of:${e.id}`, e.meta ? 1 : 0, e.createdAt);
    }
    return { copied: seq };
  }

  // ---------- 四视图（MD 1.2） ----------

  stateAt(worldId: string, upto?: { worldTime?: number; sequence?: number }): WorldState {
    return replay(this.listEvents(worldId), worldId, upto);
  }
  stateVisibleTo(worldId: string, viewerCharId: string, upto?: { worldTime?: number }, present?: Set<string>): WorldState {
    return replayVisible(this.listEvents(worldId), worldId, viewerCharId, upto, present);
  }
  diff(worldId: string, a: { worldTime?: number; sequence?: number }, b: { worldTime?: number; sequence?: number }): StateDiff {
    return diffStates(this.stateAt(worldId, a), this.stateAt(worldId, b));
  }
  timeline(worldId: string): Array<{ sequence: number; worldTime: number; label?: string; kind: string; summary: string }> {
    return this.listEvents(worldId).filter(e => !e.meta && !e.supersededBy).map(e => ({
      sequence: e.sequence, worldTime: e.worldTime, label: e.worldTimeLabel, kind: e.kind,
      summary: summarize(e),
    }));
  }

  setWorldMaxTier(id: string, tier: 'safe' | 'standard' | 'open') {
    this.db.prepare('UPDATE worlds SET max_tier=? WHERE id=?').run(tier, id);
  }

  /** 内容分级三方取小（MD 5.1）：min(user, card/pack, global)，中途只收紧 */
  resolveTier(user: string | undefined, card: string | undefined, worldId: string): 'safe' | 'standard' | 'open' {
    const order = ['safe', 'standard', 'open'];
    const g = (() => {
      try { const r = this.db.prepare('SELECT max_tier FROM worlds WHERE id=?').get(worldId) as any; return r?.max_tier ?? 'open'; } catch { return 'open'; }
    })();
    const pick = (t?: string) => (t && order.includes(t) ? order.indexOf(t) : 2);
    return order[Math.min(pick(user), pick(card), pick(g))] as 'safe' | 'standard' | 'open';
  }

  // ---------- 元层 prompt 覆盖（MD 3.5 自进化：仅元层，链式可回滚） ----------

  savePromptOverride(worldId: string, role: string, text: string): { id: string; prevId: string | null } {
    const prev = this.db.prepare('SELECT id FROM prompt_overrides WHERE world_id=? AND role=? ORDER BY created_at DESC LIMIT 1').get(worldId, role) as any;
    const id = randomUUID();
    this.db.prepare('INSERT INTO prompt_overrides (id, world_id, role, text, prev_id, created_at) VALUES (?,?,?,?,?,?)')
      .run(id, worldId, role, text, prev?.id ?? null, new Date().toISOString());
    return { id, prevId: prev?.id ?? null };
  }
  latestPromptOverride(worldId: string, role: string): string | null {
    const r = this.db.prepare('SELECT text FROM prompt_overrides WHERE world_id=? AND role=? ORDER BY created_at DESC LIMIT 1').get(worldId, role) as any;
    return r?.text ?? null;
  }
  promptOverrideHistory(worldId: string, role?: string): any[] {
    const rows = role
      ? this.db.prepare('SELECT * FROM prompt_overrides WHERE world_id=? AND role=? ORDER BY created_at DESC').all(worldId, role)
      : this.db.prepare('SELECT * FROM prompt_overrides WHERE world_id=? ORDER BY created_at DESC').all(worldId);
    return rows as any[];
  }
  /** 回滚 = 恢复 prev_id 的文本为新头部（不删除历史，MD 1.2 原则） */
  rollbackPromptOverride(id: string): boolean {
    const cur = this.db.prepare('SELECT * FROM prompt_overrides WHERE id=?').get(id) as any;
    if (!cur?.prev_id) return false;
    const prev = this.db.prepare('SELECT * FROM prompt_overrides WHERE id=?').get(cur.prev_id) as any;
    this.savePromptOverride(cur.world_id, cur.role, prev.text);
    return true;
  }

  // ---------- guidance（MD 3.5 Guidance 锚点） ----------

  addGuidance(g: Omit<Guidance, 'id' | 'createdAt'> & { id?: string; worldId?: string }): Guidance {
    const row: Guidance = { id: g.id ?? randomUUID(), title: g.title, description: g.description, source: g.source, active: g.active, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO guidance (id, world_id, title, description, source, active, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(row.id, (g as any).worldId ?? '', row.title, row.description, row.source, row.active ? 1 : 0, row.createdAt);
    return row;
  }
  listGuidance(worldId?: string): Guidance[] {
    const rows = worldId
      ? this.db.prepare('SELECT * FROM guidance WHERE world_id=? ORDER BY created_at DESC').all(worldId)
      : this.db.prepare('SELECT * FROM guidance ORDER BY created_at DESC').all();
    return (rows as any[]).map(r => ({ id: r.id, title: r.title, description: r.description, source: r.source, active: !!r.active, createdAt: r.created_at }));
  }
  setGuidanceActive(id: string, active: boolean) {
    this.db.prepare('UPDATE guidance SET active=? WHERE id=?').run(active ? 1 : 0, id);
  }

  // ---------- proposals（对抗审漏斗，MD 2.2） ----------

  saveProposal(p: Proposal) {
    this.db.prepare('INSERT OR REPLACE INTO proposals (id, world_id, base_seq, events, auto_check, adversarial, status, created_at, source_label) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(p.id, p.worldId, p.baseSeq ?? null, JSON.stringify(p.events), JSON.stringify(p.autoCheck), p.adversarial ? JSON.stringify(p.adversarial) : null, p.status, p.createdAt, p.sourceLabel);
  }
  listProposals(worldId?: string, status?: string): Proposal[] {
    const conds: string[] = []; const args: any[] = [];
    if (worldId) { conds.push('world_id=?'); args.push(worldId); }
    if (status) { conds.push('status=?'); args.push(status); }
    const rows = this.db.prepare(`SELECT * FROM proposals ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''} ORDER BY created_at DESC`).all(...args) as any[];
    return rows.map(r => ({
      id: r.id, worldId: r.world_id, baseSeq: r.base_seq ?? undefined, events: JSON.parse(r.events), autoCheck: JSON.parse(r.auto_check),
      adversarial: r.adversarial ? JSON.parse(r.adversarial) : null, status: r.status, createdAt: r.created_at, sourceLabel: r.source_label,
    }));
  }
  getProposal(id: string): Proposal | undefined {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id=?').get(id) as any;
    if (!r) return undefined;
    return { id: r.id, worldId: r.world_id, baseSeq: r.base_seq ?? undefined, events: JSON.parse(r.events), autoCheck: JSON.parse(r.auto_check), adversarial: r.adversarial ? JSON.parse(r.adversarial) : null, status: r.status, createdAt: r.created_at, sourceLabel: r.source_label };
  }
  setProposalStatus(id: string, status: Proposal['status']) {
    this.db.prepare('UPDATE proposals SET status=? WHERE id=?').run(status, id);
  }
  applyProposal(id: string): WorldEvent[] {
    const p = this.getProposal(id);
    if (!p || p.status !== 'approved') return [];
    const out: WorldEvent[] = [];
    for (const pe of p.events as any[]) {
      out.push(this.append({
        worldId: pe.worldId, workId: pe.workId, worldTime: pe.worldTime, worldTimeLabel: pe.worldTimeLabel,
        actor: 'agent', kind: pe.kind, payload: pe.payload, visibility: pe.visibility,
        review: { status: 'approved', by: 'funnel', confidence: 0.9 }, sourceRef: p.id, meta: pe.meta,
      }));
    }
    return out;
  }

  // ---------- schema 迁移（MD §14.3：v1→v2 演练；只加不改原则的示例映射） ----------

  /** 把 v1 旧事件迁移到 v2（kind 别名归一）。幂等：已 v2 的行不动。 */
  migrateLegacyEvents(worldId?: string): { migrated: number } {
    const rows = worldId
      ? this.db.prepare('SELECT id, kind, schema_ver FROM events WHERE schema_ver < ? AND world_id=?').all(SCHEMA_VER, worldId) as any[]
      : this.db.prepare('SELECT id, kind, schema_ver FROM events WHERE schema_ver < ?').all(SCHEMA_VER) as any[];
    const ALIAS: Record<string, string> = {
      'character.create': 'char.create', 'character.update': 'char.update', 'character.death': 'char.death',
      'move': 'location.move', 'set_fact': 'fact.set', 'set_relation': 'relation.set',
    };
    const upd = this.db.prepare('UPDATE events SET kind=?, schema_ver=? WHERE id=?');
    let n = 0;
    for (const r of rows) {
      upd.run(ALIAS[r.kind] ?? r.kind, SCHEMA_VER, r.id);
      n++;
    }
    return { migrated: n };
  }

  // ---------- usage / cost（MD 6 成本透明） ----------

  logUsage(u: { worldId?: string; role: string; model: string; inputTokens: number; outputTokens: number; costUsd?: number; label?: string }) {
    this.db.prepare('INSERT INTO usage_log (ts, world_id, role, model, input_tokens, output_tokens, cost_usd, label) VALUES (?,?,?,?,?,?,?,?)')
      .run(new Date().toISOString(), u.worldId ?? null, u.role, u.model, u.inputTokens, u.outputTokens, u.costUsd ?? null, u.label ?? null);
  }
  usageReport(worldId?: string) {
    const rows = worldId
      ? this.db.prepare('SELECT role, model, COUNT(*) AS calls, SUM(input_tokens) AS it, SUM(output_tokens) AS ot FROM usage_log WHERE world_id=? GROUP BY role, model').all(worldId)
      : this.db.prepare('SELECT role, model, COUNT(*) AS calls, SUM(input_tokens) AS it, SUM(output_tokens) AS ot FROM usage_log GROUP BY role, model').all();
    return rows;
  }
}

function rowToEvent(r: any): WorldEvent {
  return {
    schemaVer: r.schema_ver, id: r.id, sequence: r.sequence, worldId: r.world_id, workId: r.work_id,
    worldTime: r.world_time, worldTimeLabel: r.world_time_label ?? undefined,
    chapterRef: r.chapter_ref, turnRef: r.turn_ref, actor: r.actor, kind: r.kind,
    payload: JSON.parse(r.payload), visibility: JSON.parse(r.visibility), review: JSON.parse(r.review),
    supersededBy: r.superseded_by, sourceRef: r.source_ref, createdAt: r.created_at, meta: !!r.meta,
  } as WorldEvent;
}

function summarize(e: WorldEvent): string {
  const p: any = e.payload;
  switch (e.kind) {
    case 'char.create': return `${p.name} 登场`;
    case 'char.death': return `${p.id} 死亡`;
    case 'char.revive': return `${p.id} 复活`;
    case 'relation.set': return `${p.from} —${p.type}→ ${p.to}`;
    case 'relation.end': return `关系 ${p.id} 结束`;
    case 'fact.set': return `${p.key} = ${p.value}`;
    case 'location.move': return `${p.charId} → ${p.place}`;
    case 'item.create': return `物品 ${p.name}`;
    case 'item.transfer': return `${p.id} → ${p.holder}`;
    case 'foreshadow.plant': return `伏笔：${String(p.description).slice(0, 20)}`;
    case 'foreshadow.recover': return `回收伏笔 ${p.id}`;
    default: return e.kind;
  }
}

export { diffStates, isEmptyDiff };
