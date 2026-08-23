// StoryPack 玩侧门面（MD 5.1）：节点图 + EntryRole + canon 硬跳 + mainline/free
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type EntryRole = 'protagonist' | 'supporting' | 'extra' | 'isekai';
export type PlayMode = 'mainline' | 'free';
export type OptionTag = 'canon' | 'advance' | 'idle';

export interface PackOption { text: string; tag?: OptionTag; nextNodeId?: string }
export interface PackNode {
  id: string; text: string;
  options: PackOption[];
  /** 章级原著锚点（canon 硬跳目标） */
  canonNodeId?: boolean;
}
export interface PackChapter { id: string; title: string; worldTime: number; canonNodeId: string; nodes: PackNode[] }
export interface StoryPack {
  id: string; worldId: string; title: string; description?: string;
  characters: string[];              // 可入场角色 id
  chapters: PackChapter[];
  createdAt: string;
}

export interface PackProgress {
  packId: string;
  entryRole: EntryRole;
  playMode: PlayMode;
  chapterCursor: string;
  nodeId: string;
  visitedNodes: string[];
  rewriteIntensity: 'canon' | 'rewrite';
  metaKnowledge: 'none' | 'reader';
}

/** 可玩门槛（MuseAI 红线）：≥1 角色 + ≥2 章 + 节点链连通 */
export function packPlayable(p: StoryPack): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!p.characters.length) issues.push('缺少角色引用');
  if (p.chapters.length < 2) issues.push('章节数 < 2');
  for (const ch of p.chapters) {
    if (!ch.nodes.length) issues.push(`章「${ch.title}」无节点`);
  }
  const first = p.chapters[0]?.nodes[0];
  if (first) {
    const reach = new Set<string>();
    const stack = [first.id];
    while (stack.length) {
      const id = stack.pop()!;
      if (reach.has(id)) continue;
      reach.add(id);
      for (const ch of p.chapters) for (const n of ch.nodes) {
        if (n.id === id) for (const o of n.options) if (o.nextNodeId) stack.push(o.nextNodeId);
      }
    }
    if (reach.size < 2) issues.push('节点链不连通');
  }
  return { ok: issues.length === 0, issues };
}

export class PackStore {
  constructor(private root: string) { mkdirSync(join(root, 'packs'), { recursive: true }); }
  path(id: string) { return join(this.root, 'packs', `${id}.json`); }
  save(p: StoryPack) { writeFileSync(this.path(p.id), JSON.stringify(p, null, 1), 'utf8'); }
  get(id: string): StoryPack | null {
    const p = this.path(id);
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
  }
  list(worldId?: string): StoryPack[] {
    const d = join(this.root, 'packs');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter(f => f.endsWith('.json')).map(f => {
      try { return JSON.parse(readFileSync(join(d, f), 'utf8')) as StoryPack; } catch { return null; }
    }).filter((p): p is StoryPack => !!p && (!worldId || p.worldId === worldId));
  }
  delete(id: string) { const p = this.path(id); if (existsSync(p)) rmSync(p); }

  startProgress(pack: StoryPack, entryRole: EntryRole, opts: { playMode?: PlayMode; rewriteIntensity?: 'canon' | 'rewrite'; metaKnowledge?: 'none' | 'reader' } = {}): PackProgress {
    const first = pack.chapters[0];
    return {
      packId: pack.id, entryRole,
      playMode: opts.playMode ?? 'mainline',
      chapterCursor: first.id, nodeId: first.nodes[0].id,
      visitedNodes: [first.nodes[0].id],
      rewriteIntensity: opts.rewriteIntensity ?? 'canon',
      metaKnowledge: opts.metaKnowledge ?? 'reader',
    };
  }
  nodeOf(pack: StoryPack, progress: PackProgress): { chapter: PackChapter; node: PackNode } | null {
    for (const ch of pack.chapters) {
      const n = ch.nodes.find(x => x.id === progress.nodeId);
      if (n) return { chapter: ch, node: n };
    }
    return null;
  }
  /** 引擎标签白名单（MD 5.1）：canon=硬跳章锚点；advance=走 nextNodeId；idle=不推进 */
  chooseOption(pack: StoryPack, progress: PackProgress, optionIndex: number): { progress: PackProgress; jumpedCanon: boolean; note?: string } {
    const at = this.nodeOf(pack, progress);
    if (!at) return { progress, jumpedCanon: false };
    const opt = at.node.options[optionIndex];
    let nextNodeId = progress.nodeId;
    let jumpedCanon = false;
    let note: string | undefined;
    if (opt?.tag === 'canon') {
      nextNodeId = at.chapter.canonNodeId;
      jumpedCanon = true;
      note = '回归原著锚点';
    } else if (opt?.nextNodeId) {
      nextNodeId = opt.nextNodeId;
    } else if (opt?.tag === 'advance') {
      const ch = pack.chapters.find(c => c.id === progress.chapterCursor);
      const ci = pack.chapters.findIndex(c => c.id === progress.chapterCursor);
      const next = pack.chapters[ci + 1];
      if (next) { nextNodeId = next.nodes[0].id; progress.chapterCursor = next.id; note = `进入《${next.title}》`; }
      void ch;
    }
    const p: PackProgress = { ...progress, nodeId: nextNodeId, visitedNodes: [...new Set([...progress.visitedNodes, nextNodeId])] };
    return { progress: p, jumpedCanon, note };
  }
}

export function entryRolePrompt(role: EntryRole, charName: string | null): string {
  const n = charName ?? '原创角色';
  switch (role) {
    case 'protagonist': return `玩家以主角 ${n} 的身份行动，剧情围绕其展开。`;
    case 'supporting': return `玩家以配角 ${n} 的身份行动，可推动但不可取代主线主角。`;
    case 'extra': return `玩家以路人 ${n} 的身份旁观主线，从边缘视角介入剧情。`;
    case 'isekai': return `玩家以异世界来客 ${n} 的身份进入故事，原著角色不认识玩家。`;
  }
}

export function newPackId() { return `pack-${randomUUID().slice(0, 8)}`; }
export function newNodeId() { return `n-${randomUUID().slice(0, 6)}`; }
