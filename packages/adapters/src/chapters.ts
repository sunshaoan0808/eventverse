// 启发式切章（MD 2.1：正则为主，失败按字数窗，不依赖 LLM 切章）+ 时间归位 v0
import { randomUUID } from 'node:crypto';

export interface SplitChapter { title: string; body: string; index: number }

const CHAPTER_PATTERNS = [
  /^[ \t]*(第[零一二三四五六七八九十百千万0-9]+[章回节卷幕][^\n]{0,40})$/gm,
  /^[ \t]*((?:Chapter|CHAPTER)\s+\d+[^\n]{0,40})$/gm,
  /^[ \t]*(序章|楔子|尾声|后记|番外[^\n]{0,20})$/gm,
];

// 嵌入式标题：部分 txt 源把"第X章标题"粘在段落末尾（无换行）。
// 规则：标题全为短汉字串（≤12 字、无标点），且第字前一个字不是常见引用动词/助词（排除"翻到第三章就…"这类行文引用）。
const EMBED_HEADING = /第[零一二三四五六七八九十百千万0-9]{1,6}[章回节][\u4e00-\u9fa5]{1,10}(?=\n|$)/g;
const PREV_EXCLUDE = new Set(['在', '是', '到', '说', '的', '了', '看', '读', '写', '讲', '翻', '跳', '这', '那', '记', '提', '写', '给', '和', '与', '章']);

function embeddedMarks(text: string): Array<{ title: string; start: number }> {
  const out: Array<{ title: string; start: number }> = [];
  EMBED_HEADING.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EMBED_HEADING.exec(text)) !== null) {
    const prev = text[m.index - 1];
    if (prev && PREV_EXCLUDE.has(prev)) continue;
    out.push({ title: m[0], start: m.index });
  }
  return out;
}

export function splitChapters(text: string, opts: { windowChars?: number } = {}): SplitChapter[] {
  const normalized = text.replace(/\r\n/g, '\n');
  // 中文标记（第X章 + 楔子/序章等）合并收集；英文 Chapter 独立
  const collect = (pats: RegExp[]) => {
    const marks: Array<{ title: string; start: number }> = [];
    for (const pat of pats) {
      pat.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pat.exec(normalized)) !== null) marks.push({ title: m[1].trim(), start: m.index });
    }
    return marks.sort((a, b) => a.start - b.start).filter((m, i, arr) => i === 0 || m.start !== arr[i - 1].start);
  };
  let marks = collect([CHAPTER_PATTERNS[0], CHAPTER_PATTERNS[2]]);
  if (marks.length < 2) marks = collect([CHAPTER_PATTERNS[1]]);
  if (marks.length < 2) marks = embeddedMarks(normalized); // ★行首匹配失败 → 嵌入式标题兜底
  if (marks.length < 2) {
    // 字数窗降级
    const win = opts.windowChars ?? 6000;
    marks = [];
    for (let i = 0, idx = 1; i < normalized.length; i += win, idx++) marks.push({ title: `片段 ${idx}`, start: i });
    if (!marks.length) marks = [{ title: '全文', start: 0 }];
  } else if (marks[0].start > 0) {
    marks.unshift({ title: '开篇', start: 0 });
  }
  const out: SplitChapter[] = [];
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : normalized.length;
    const body = normalized.slice(marks[i].start, end).trim();
    if (body) out.push({ title: marks[i].title, body, index: out.length });
  }
  return out;
}

// ---------- 时间归位 v0（MD 2.1：锚点 + 相对表达解析 + 粗粒度） ----------

export interface TimeAnchor { baseYear: number; label?: string }

const REL_PAT = /(第[一二三四五六七八九十百千0-9]+[年月日天](?:[之]?后|前))|([0-9一二三四五六七八九十百千]+)\s*(年|月|日|天)\s*(后|前)|((?:翌|次|当|隔)[年月日])/g;

export function parseRelativeTime(text: string, current: number): number | null {
  const rel = text.match(/([0-9一二三四五六七八九十百千]+)\s*(年|月|日|天)\s*(后|前)/);
  if (rel) {
    const n = cnNum(rel[1]);
    const unit = rel[2];
    const dir = rel[3] === '前' ? -1 : 1;
    const delta = unit === '年' ? n : unit === '月' ? n / 12 : n / 365;
    return roundTime(current + dir * delta);
  }
  if (/翌年|次年|第二年/.test(text)) return roundTime(current + 1);
  if (/当年|同一年/.test(text)) return current;
  return null;
}

export function cnNum(s: string): number {
  const map: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  let n = 0, section = 0;
  for (const ch of s) {
    if (map[ch] != null) { section = map[ch]; }
    else if (ch === '十') { section = (section || 1) * 10; n += section; section = 0; }
    else if (ch === '百') { section = (section || 1) * 100; n += section; section = 0; }
    else if (ch === '千') { section = (section || 1) * 1000; n += section; section = 0; }
  }
  return n + section;
}

export function roundTime(t: number): number { return Math.round(t * 100) / 100; }

export function timeLabel(t: number): string {
  const year = Math.floor(t);
  const frac = t - year;
  const season = frac < 0.125 ? '初' : frac < 0.375 ? '春' : frac < 0.625 ? '夏' : frac < 0.875 ? '秋' : '冬';
  return `${year} 年${season === '初' ? '初' : season}`;
}

/** 全文顺序归位：逐章扫描相对表达，传播世界时间（v0 粗粒度） */
export function assignWorldTimes(bodies: string[], anchor: TimeAnchor): number[] {
  const times: number[] = [];
  let cur = anchor.baseYear;
  for (const b of bodies) {
    const rel = parseRelativeTime(b.slice(0, 2000), cur);
    if (rel != null) cur = rel;
    times.push(roundTime(cur + 0.01 * (times.length % 40))); // 同年内微错开，保证排序稳定
  }
  return times;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
