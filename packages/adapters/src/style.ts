// 平淡检测器（MD 3.4 文风解法③）：全部确定性指标，零 LLM
export interface ProseMetrics {
  lexicalDiversity: number;      // 词汇多样性（unique/total）
  sentenceLenVariance: number;   // 句长方差（低 = 机器节奏）
  aiClicheDensity: number;       // AI 腔词典命中密度（次/千字）
  verdict: 'flat' | 'ok' | 'good';
  issues: string[];
}

const AI_CLICHES = [
  '不禁', '仿佛', '一丝', '一抹', '淡淡的', '静静地', '缓缓地', '微微',
  '眼中闪过', '嘴角勾起', '勾起一抹', '空气中弥漫', '岁月静好', '内心深处',
  '犹如', '宛如', '恍若', '某种', '说不清道不明', '难以言喻', '自然而然地',
  '显得格外', '格外', '似乎在诉说着', '无言的', '无声的',
];

export function analyzeProse(text: string): ProseMetrics {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { lexicalDiversity: 0, sentenceLenVariance: 0, aiClicheDensity: 0, verdict: 'flat', issues: ['空文本'] };
  const tokens = clean.match(/[\u4e00-\u9fa5]|[a-zA-Z]+/g) ?? [];
  const unique = new Set(tokens).size;
  const lexicalDiversity = tokens.length ? unique / tokens.length : 0;

  const sentences = clean.split(/[。！？!?…]+/).map(s => s.trim()).filter(Boolean);
  const lens = sentences.map(s => s.length);
  const mean = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / (lens.length || 1);

  let hits = 0;
  for (const c of AI_CLICHES) {
    let idx = clean.indexOf(c);
    while (idx >= 0) { hits++; idx = clean.indexOf(c, idx + c.length); }
  }
  const aiClicheDensity = (hits / Math.max(clean.length, 1)) * 1000;

  const issues: string[] = [];
  if (lexicalDiversity < 0.35) issues.push('词汇重复度高');
  if (variance < 60) issues.push('句长过于均匀（机器节奏）');
  if (aiClicheDensity > 12) issues.push('AI 腔词汇密集');

  const score = (lexicalDiversity >= 0.45 ? 1 : 0) + (variance >= 120 ? 1 : 0) + (aiClicheDensity <= 6 ? 1 : 0);
  // AI 腔密度一票否决：命中密集时无论句式如何都判平
  const verdict = aiClicheDensity > 12 || score === 0 ? 'flat' : score >= 2 && issues.length === 0 ? 'good' : 'ok';
  return { lexicalDiversity: round4(lexicalDiversity), sentenceLenVariance: round(variance), aiClicheDensity: round(aiClicheDensity), verdict, issues };
}

function round4(n: number) { return Math.round(n * 10000) / 10000; }
function round(n: number) { return Math.round(n * 10) / 10; }
