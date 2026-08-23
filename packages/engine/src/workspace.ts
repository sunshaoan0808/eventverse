// 工作区：章节正文（Markdown 文件）+ RP/写作会话 + 设置（密钥 AES 加密落盘）
// MD 1.4 / 6 / 8：本地优先，默认数据目录 ./data
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID, createCipheriv, createDecipheriv, scryptSync, randomBytes } from 'node:crypto';
import { ProviderConfig } from '@eventverse/adapters';
import { ChapterMeta } from '@eventverse/core';

export interface SessionTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  meta?: { idle?: boolean; beats?: string[]; prose?: any; costUsd?: number; deltas?: string[]; options?: string[] };
}

export interface RPProfile {
  charId: string | null;          // 玩家所扮角色（可见性过滤目标）
  focusCharId: string | null;     // 焦点 NPC
  styleAnchorFrom?: string;       // 文风锚定：从哪章取范例
  contentTier?: 'safe' | 'standard' | 'open';
  /** 玩侧 StoryPack 进度（节点图/EntryRole/PlayMode） */
  pack?: import('./packs.js').PackProgress;
}

export interface ChatSession {
  id: string; worldId: string; workId: string | null;
  mode: 'rp' | 'write';
  title: string; createdAt: string;
  profile?: RPProfile;
  turns: SessionTurn[];
  /** 前情提要（95% 压缩产物，MD §6） */
  summary?: string;
  compressedAt?: string;
}

export class Workspace {
  constructor(public root: string) {
    mkdirSync(join(root, 'works'), { recursive: true });
    mkdirSync(join(root, 'sessions'), { recursive: true });
  }

  // ---------- 章节正文文件 ----------
  chapterPath(workId: string, chapterId: string) { return join(this.root, 'works', workId, `${chapterId}.md`); }

  writeChapterBody(workId: string, chapterId: string, body: string) {
    const p = this.chapterPath(workId, chapterId);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }
  readChapterBody(workId: string, chapterId: string): string | null {
    const p = this.chapterPath(workId, chapterId);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }
  deleteChapterBody(workId: string, chapterId: string) {
    const p = this.chapterPath(workId, chapterId);
    if (existsSync(p)) rmSync(p);
  }
  deleteWorkDir(workId: string) {
    const d = join(this.root, 'works', workId);
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
  }

  // ---------- 会话 ----------
  sessionPath(id: string) { return join(this.root, 'sessions', `${id}.json`); }

  saveSession(s: ChatSession) {
    writeFileSync(this.sessionPath(s.id), JSON.stringify(s, null, 1), 'utf8');
  }
  getSession(id: string): ChatSession | null {
    const p = this.sessionPath(id);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }
  listSessions(worldId?: string): ChatSession[] {
    const d = join(this.root, 'sessions');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter(f => f.endsWith('.json')).map(f => {
      try { return JSON.parse(readFileSync(join(d, f), 'utf8')) as ChatSession; } catch { return null; }
    }).filter((s): s is ChatSession => !!s && (!worldId || s.worldId === worldId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  deleteSession(id: string) {
    const p = this.sessionPath(id);
    if (existsSync(p)) rmSync(p);
  }

  newSession(worldId: string, mode: 'rp' | 'write', title: string, workId: string | null, profile?: RPProfile): ChatSession {
    const s: ChatSession = { id: `s-${randomUUID().slice(0, 12)}`, worldId, workId, mode, title, createdAt: new Date().toISOString(), profile, turns: [] };
    this.saveSession(s);
    return s;
  }

  // ---------- 设置（LLM 供应商，密钥 AES-256-GCM 加密，master.key 本地生成） ----------
  private masterKeyPath() { return join(this.root, 'master.key'); }

  private masterKey(): Buffer {
    const p = this.masterKeyPath();
    if (!existsSync(p)) writeFileSync(p, randomBytes(32));
    return scryptSync(readFileSync(p), 'eventverse-salt', 32);
  }

  encryptSecret(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.masterKey(), iv);
    const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
  }
  decryptSecret(vault: string): string {
    const [iv, tag, data] = vault.split('.').map(x => Buffer.from(x, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.masterKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  }

  providersPath() { return join(this.root, 'settings.json'); }

  loadProviders(): ProviderConfig[] {
    const p = this.providersPath();
    if (!existsSync(p)) return this.defaultProviders();
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return (j.providers ?? []).map((x: any) => ({ ...x, apiKey: x.apiKeyVault ? this.decryptSecret(x.apiKeyVault) : '' }));
  }
  saveProviders(list: ProviderConfig[]) {
    const masked = list.map(p => {
      const { apiKey, ...rest } = p;
      return { ...rest, apiKeyVault: apiKey ? this.encryptSecret(apiKey) : undefined, hasKey: !!apiKey };
    });
    writeFileSync(this.providersPath(), JSON.stringify({ providers: masked }, null, 1), 'utf8');
  }

  /** 默认配置：五个角色全部指到 mock —— 零配置开箱即用（MD：离线演示可用） */
  defaultProviders(): ProviderConfig[] {
    const mk = (role: ProviderConfig['role']): ProviderConfig => ({
      id: `mock-${role}`, protocol: 'mock', baseUrl: '', apiKey: '', model: 'mock-1', role,
    });
    return [mk('renderer'), mk('director'), mk('extractor'), mk('adversarial'), mk('chat')];
  }

  providerFor(role: ProviderConfig['role']): ProviderConfig {
    const list = this.loadProviders();
    return list.find(p => p.role === role) ?? list[0] ?? this.defaultProviders()[0];
  }
}
