// EventVerse core types — 事件模型 v2（world/work 分离 + schema_ver，MD 1.1 节）

export const SCHEMA_VER = 2;

/** 世界内时间：故事年（浮点，粗粒度季/年即可，如 1014.25 = 1014 年春） */
export type WorldTime = number;

export type Actor = 'author' | 'agent' | 'import' | 'system';

export type ReviewStatus = 'pending' | 'auto_ok' | 'conflict' | 'high_impact' | 'approved' | 'rejected';

export interface Visibility {
  /** 知情者角色 id 列表；'*' 表示公开 */
  knowers: string[] | '*';
  /** 从哪个事件起知情（sequence）；0 = 一直知道 */
  sinceEvent?: number;
  scope: 'secret' | 'group' | 'public';
  /** 场景维度（M3 后实装）：auto = 在场者临时互见 */
  inScene?: 'auto';
}

export type EventKind =
  | 'char.create' | 'char.update' | 'char.death' | 'char.revive'
  | 'relation.set' | 'relation.end'
  | 'fact.set'
  | 'location.move'
  | 'item.create' | 'item.transfer'
  | 'foreshadow.plant' | 'foreshadow.recover'
  | 'chapter.anchor'
  | 'intent.set'
  | 'meta.rollback' | 'meta.note';

export interface EventPayloads {
  'char.create': { id: string; name: string; aliases?: string[]; gender?: string; attrs?: Record<string, string> };
  'char.update': { id: string; patch: { name?: string; aliases?: string[]; attrs?: Record<string, string> } };
  'char.death': { id: string };
  'char.revive': { id: string; reason?: string };
  'relation.set': { id: string; from: string; to: string; type: string; validFrom: WorldTime; validTo?: WorldTime | null; note?: string };
  'relation.end': { id: string; validTo: WorldTime; reason?: string };
  'fact.set': { key: string; value: string; validFrom: WorldTime; validTo?: WorldTime | null };
  'location.move': { charId: string; place: string };
  'item.create': { id: string; name: string; holder?: string };
  'item.transfer': { id: string; holder: string };
  'foreshadow.plant': { id: string; description: string; deadlineWorldTime?: WorldTime | null };
  'foreshadow.recover': { id: string; note?: string };
  'chapter.anchor': { workId: string; chapterId: string; title: string };
  'intent.set': { description: string; priority?: number };
  'meta.rollback': { targetEventId: string; reason?: string };
  'meta.note': { text: string };
}

export interface WorldEvent<K extends keyof EventPayloads = keyof EventPayloads> {
  schemaVer: number;
  id: string;
  /** work 内全局单调序，由 store 分配 */
  sequence: number;
  worldId: string;
  /** 该事件归属的作品（正文锚点）；系统级事件可为 null */
  workId: string | null;
  worldTime: WorldTime;
  /** 世界时间的人类可读标注，如"1014 年冬" */
  worldTimeLabel?: string;
  chapterRef?: string | null;
  turnRef?: string | null;
  actor: Actor;
  kind: K;
  payload: EventPayloads[K];
  visibility: Visibility;
  review: { status: ReviewStatus; by?: string; confidence?: number };
  /** 被哪条事件推翻（回滚/修正链）；非 null 的事件不参与重放 */
  supersededBy: string | null;
  /** 事实来源：章节 id / job id / 手改——全链路可审计 */
  sourceRef?: string | null;
  createdAt: string;
  /** 元层事件（intent/meta）不参与状态重放 */
  meta?: boolean;
}

/** 派生状态：重放的产物 */
export interface CharacterState {
  id: string; name: string; aliases: string[]; gender?: string;
  attrs: Record<string, string>; isDead: boolean; diedAt?: WorldTime;
}

export interface RelationState {
  id: string; from: string; to: string; type: string;
  validFrom: WorldTime; validTo: WorldTime | null; note?: string;
}

export interface FactState { key: string; value: string; validFrom: WorldTime; validTo: WorldTime | null; }

export interface ItemState { id: string; name: string; holder?: string; }

export interface ForeshadowState {
  id: string; description: string; plantedAt: WorldTime;
  deadlineWorldTime: WorldTime | null; recoveredAt: WorldTime | null;
}

export interface IntentState { description: string; priority: number; setAt: WorldTime; }

export interface WorldState {
  worldId: string;
  asOf: { sequence: number; worldTime: WorldTime };
  characters: Record<string, CharacterState>;
  relations: RelationState[];
  facts: FactState[];
  locations: Record<string, string>;
  items: Record<string, ItemState>;
  foreshadowings: ForeshadowState[];
  intents: IntentState[];
}

export function emptyState(worldId: string): WorldState {
  return {
    worldId,
    asOf: { sequence: 0, worldTime: -Infinity },
    characters: {}, relations: [], facts: [], locations: {},
    items: {}, foreshadowings: [], intents: [],
  };
}

export interface Guidance {
  id: string; title: string; description: string;
  source: string; active: boolean; createdAt: string;
}

/** 一条对世界的候选修改（漏斗产物） */
export interface Proposal {
  id: string;
  worldId: string;
  /** 乐观锁基线：创建时的最大 sequence（批准时校验世界是否被并发推进） */
  baseSeq?: number;
  events: Array<Omit<WorldEvent, 'id' | 'sequence' | 'schemaVer' | 'createdAt'> & { id?: string }>;
  /** 自动校验结果 */
  autoCheck: { ok: boolean; issues: string[] };
  /** 对抗审结果 */
  adversarial: { verdict: 'normal' | 'conflict' | 'high_impact'; reason?: string } | null;
  /** 最终处置 */
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  sourceLabel: string;
}

export interface WorkMeta {
  id: string; worldId: string; title: string; author?: string;
  description?: string; createdAt: string;
}

export interface ChapterMeta {
  id: string; workId: string; title: string; index: number;
  /** 世界时间锚（本章开头对应的故事年） */
  worldTime: WorldTime; worldTimeLabel?: string;
  kind: 'body' | 'setting' | 'other';
  wordCount?: number;
}
