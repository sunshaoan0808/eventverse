import { describe, it, expect } from 'vitest';
import { splitChapters, parseRelativeTime, cnNum, assignWorldTimes, timeLabel } from './chapters.js';
import { parseSTCard, normalizeWorldBook, extractCardFromPng, exportWorldBookFromFacts } from './st.js';
import { analyzeProse, extractJson } from './index.js';

describe('切章', () => {
  it('识别中文章节标题', () => {
    const text = '第一章 初入江湖\n正文A……\n第二章 风起\n正文B……\n第三章 云涌\n正文C……';
    const chs = splitChapters(text);
    expect(chs.length).toBe(3);
    expect(chs[1].title).toContain('风起');
  });
  it('无章节标记时按字数窗降级', () => {
    const chs = splitChapters('x'.repeat(13000), { windowChars: 6000 });
    expect(chs.length).toBe(3);
  });
  it('楔子/序章/尾声', () => {
    const text = '楔子\n引子文\n第一章 开端\n正文';
    const chs = splitChapters(text);
    expect(chs[0].title).toBe('楔子');
  });
});

describe('时间归位 v0', () => {
  it('中文数字与相对时间', () => {
    expect(cnNum('三')).toBe(3);
    expect(cnNum('十二')).toBe(12);
    expect(parseRelativeTime('三年后，他回到了故乡。', 1010)).toBe(1013);
    expect(parseRelativeTime('翌年春天', 1010)).toBe(1011);
    expect(parseRelativeTime('风平浪静', 1010)).toBeNull();
  });
  it('全文顺序传播', () => {
    const bodies = ['开篇。', '三年后，他回来了。', '继续剧情。'];
    const times = assignWorldTimes(bodies, { baseYear: 1000 });
    expect(times[1]).toBeGreaterThanOrEqual(1003);
    expect(times[2]).toBeGreaterThanOrEqual(times[1]);
  });
  it('时间标签', () => {
    expect(timeLabel(1014)).toContain('1014');
  });
});

describe('ST 兼容', () => {
  it('解析 v2 卡与平铺 v1', () => {
    const v2 = parseSTCard({ spec: 'chara_card_v2', data: { name: '测试', description: 'd' } });
    expect(v2?.data?.name).toBe('测试');
    const v1 = parseSTCard({ name: '旧卡' });
    expect(v1?.data?.name).toBe('旧卡');
  });
  it('世界书 entries 对象/数组两种形态', () => {
    const a = normalizeWorldBook({ entries: { '0': { keys: ['k'], content: 'c', constant: true } } });
    const b = normalizeWorldBook({ entries: [{ keys: ['k'], content: 'c', constant: true }] });
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
  });
  it('PNG tEXt chunk 抽卡', () => {
    const cardJson = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'PNG卡' } });
    const b64 = Buffer.from(cardJson, 'utf8').toString('base64');
    const png = buildPngWithChara(b64);
    const card = extractCardFromPng(png);
    expect(card?.data?.name).toBe('PNG卡');
  });
  it('导出世界书', () => {
    const wb = exportWorldBookFromFacts([{ key: 'setting:帝国', value: '景朝' }], '导出');
    expect(Object.keys((wb.entries as any)).length).toBe(1);
  });
});

describe('平淡检测器', () => {
  it('检测 AI 腔密集文本为 flat', () => {
    const flat = '他不禁微微一笑，眼中闪过一丝淡淡的笑意。空气中弥漫着一丝说不清道不明的气息。她缓缓地转身，嘴角勾起一抹弧度，仿佛在诉说着什么。他宛如雕塑般静静地看着，宛如，仿佛，一丝，一抹，格外。';
    const m = analyzeProse(flat);
    expect(m.aiClicheDensity).toBeGreaterThan(12);
    expect(m.verdict).toBe('flat');
  });
  it('多样文风 ok/good', () => {
    const varied = Array.from({ length: 30 }, (_, i) =>
      i % 3 === 0 ? '刀出鞘，血溅三尺。' : i % 3 === 1 ? '他沉默了很久很久，久到烛火燃尽了半截，才终于开口。' : '走。'
    ).join('');
    const m = analyzeProse(varied);
    expect(m.verdict).not.toBe('flat');
  });
});

describe('extractJson 容错', () => {
  it('fenced / 裸 / 括号扫描', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('前缀文字 {"b":[1,2]} 后缀')).toEqual({ b: [1, 2] });
    expect(extractJson('完全不是 JSON')).toBeNull();
  });
});

// 构造带 chara tEXt 块的最小 PNG
function buildPngWithChara(b64: string): Uint8Array {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunks: Buffer[] = [sig];
  const mk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const textData = Buffer.concat([Buffer.from('chara\0', 'latin1'), Buffer.from(b64, 'latin1')]);
  chunks.push(mk('tEXt', textData));
  chunks.push(mk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}
function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
