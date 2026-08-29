// SillyTavern 生态兼容（MD 5.5）：角色卡 v2/v3 JSON + PNG tEXt 内嵌卡 + 世界书 双向
import { randomUUID } from 'node:crypto';

export interface STCharacterCard {
  spec?: string; spec_version?: string;
  data?: {
    name: string; description?: string; personality?: string; scenario?: string;
    first_mes?: string; mes_example?: string; creator_notes?: string;
    system_prompt?: string; post_history_instructions?: string;
    alternate_greetings?: string[]; tags?: string[];
    character_book?: STWorldBook;
    extensions?: any;
  };
}

export interface STWorldBook {
  name?: string; entries?: Record<string, any> | any[];
}

export function parseSTCard(json: any): STCharacterCard | null {
  const card = (typeof json === 'string' ? safeJson(json) : json) as STCharacterCard | null;
  if (!card || typeof card !== 'object') return null;
  if (card.data?.name) return card;
  // v1 平铺格式
  if ((card as any).name) {
    return { spec: 'chara_card_v2', spec_version: '2.0', data: { ...(card as any) } };
  }
  return null;
}

export function safeJson(s: string): any | null {
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- PNG 内嵌卡：解析 tEXt chunk 的 chara 字段（base64 JSON） ----------

export function extractCardFromPng(buf: Uint8Array): STCharacterCard | null {
  // PNG 签名 8 字节 + 若干 chunk（length,type,data,crc）
  if (buf.length < 8) return null;
  let off = 8;
  const dec = new TextDecoder();
  while (off + 8 <= buf.length) {
    const len = (buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3];
    const type = dec.decode(buf.slice(off + 4, off + 8));
    if (type === 'tEXt' && off + 8 + len <= buf.length) {
      const data = buf.slice(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      const key = dec.decode(data.slice(0, nul));
      const value = dec.decode(data.slice(nul + 1));
      if (key === 'chara' || key === 'ccv3') {
        try {
          const json = Buffer.from(value, 'base64').toString('utf8');
          return parseSTCard(json);
        } catch { /* ignore */ }
      }
    }
    if (type === 'IEND') break;
    off += 12 + len;
  }
  return null;
}

/** 世界书条目 → 统一中间格式（保留 constant/关键词激活语义） */
export interface WorldBookEntry {
  keys: string[]; content: string; constant: boolean; enabled: boolean; comment?: string;
}

export function normalizeWorldBook(wb: STWorldBook | undefined): WorldBookEntry[] {
  if (!wb || typeof wb !== 'object') return [];
  let raw: any[] = [];
  if (Array.isArray(wb.entries)) raw = wb.entries;
  else if (wb.entries && typeof wb.entries === 'object') raw = Object.values(wb.entries);
  else if (Array.isArray(wb as any)) raw = wb as unknown as any[];            // 顶层数组
  else raw = Object.values(wb as unknown as Record<string, any>);             // ★裸导出：顶层 uid→条目
  return raw.map((e: any) => ({
    keys: (e?.keys ?? e?.key ?? []).map(String),
    content: String(e?.content ?? ''),
    constant: !!e?.constant,
    enabled: e?.enabled !== false && (e?.disable !== true),
    comment: e?.comment ?? e?.name,
  })).filter(e => e.content);
}

// ---------- 导出：事件层 → ST 格式 ----------

export function exportWorldBookFromFacts(facts: Array<{ key: string; value: string }>, name: string): STWorldBook {
  const entries: Record<string, any> = {};
  facts.forEach((f, i) => {
    entries[String(i)] = {
      uid: i, key: [f.key.split(':').pop() ?? f.key], keysecondary: [], comment: f.key,
      content: f.value, constant: true, selective: false, order: 100, position: 0, disable: false,
    };
  });
  return { name, entries };
}

export function exportCharacterCard(ch: { name: string; description?: string; personality?: string; firstMes?: string }): STCharacterCard {
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: {
      name: ch.name, description: ch.description ?? '', personality: ch.personality ?? '',
      first_mes: ch.firstMes ?? '', tags: ['eventverse'],
    },
  };
}

export function newStId(): string { return randomUUID(); }
