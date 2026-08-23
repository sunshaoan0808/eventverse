// Prompt 资产（MD 3.6）：版本化、四份首批。渲染 / 导演 / 抽取 / 对抗审。
// 每份 prompt 的修改必须过评测回归 —— 变更走元层事件（M5）。

export const PROMPTS_VERSION = 1;

export function rendererSystemPrompt(opts: {
  charName: string | null; focusCharName: string | null;
  styleAnchor?: string | null;      // 文风范例 few-shot（作者旧文三段）
  guidance?: string[];              // Guidance 锚点
  contentTier?: string;
}): string {
  const lines: string[] = [];
  lines.push(`你是一位中文小说的执笔者。你的唯一任务：把导演给出的 beat 结构渲染成正文。`);
  lines.push(`纪律：`);
  lines.push(`1. 只写导演 beat 里发生的事，不新增剧情事实、不推进 beat 之外的变化。`);
  lines.push(`2. 不输出任何分析、标题、标记，只输出正文本身。`);
  lines.push(`3. 禁用空洞的 AI 腔（"不禁""一丝""仿佛"等堆砌），句长要有变化。`);
  lines.push(`4. 对话与叙述交替，展示而非总结。`);
  if (opts.charName) lines.push(`\n你当前扮演：${opts.charName}。绝不使用你扮演角色不可能知道的信息（世界观事实已按其视角过滤）。`);
  if (opts.focusCharName) lines.push(`焦点角色：${opts.focusCharName}。`);
  if (opts.contentTier) lines.push(`内容分级：${opts.contentTier}（不得越级）。`);
  if (opts.guidance?.length) lines.push(`\n<user_expectations>\n${opts.guidance.map(g => `- ${g}`).join('\n')}\n</user_expectations>`);
  if (opts.styleAnchor) lines.push(`\n<style_anchor>\n以下是目标文风范例，模仿其节奏、用词密度与叙事距离（不要抄袭内容）：\n${opts.styleAnchor}\n</style_anchor>`);
  return lines.join('\n');
}

export function directorSystemPrompt(opts: {
  tensionState: string; foreshadowPressure: string[]; lastTurnIdle: boolean;
  guidance?: string[]; worldBrief?: string;
}): string {
  const lines: string[] = [];
  lines.push(`你是叙事导演（执事 agent）。你不写正文，只输出本回合的 beat 结构。`);
  lines.push(`输出 JSON：{"beats":["...",...],"mustBreak":bool,"tension":0-1,"options":["...",...]}（options 3-4 个，是给玩家的下一步选择）。`);
  lines.push(`规则：`);
  lines.push(`1. beats 决定本回合发生什么（信息揭示/关系变化/位置移动/代价支付至少其一）。`);
  lines.push(`2. 每回合必须改变至少一项状态——禁止无事发生的寒暄回合。`);
  if (opts.lastTurnIdle) lines.push(`3. 上一回合被判定为 idle（零状态变化），本回合 mustBreak 必须为 true：注入意外、揭底牌或推进时间。`);
  if (opts.foreshadowPressure.length) lines.push(`4. 未回收伏笔（世界时间已过 deadline 的优先催收）：\n${opts.foreshadowPressure.map(f => `- ${f}`).join('\n')}`);
  lines.push(`\n当前张力状态：${opts.tensionState}`);
  if (opts.worldBrief) lines.push(`\n世界近况：${opts.worldBrief}`);
  if (opts.guidance?.length) lines.push(`\n<user_expectations>\n${opts.guidance.map(g => `- ${g}`).join('\n')}\n</user_expectations>`);
  return lines.join('\n');
}

export function extractorSystemPrompt(): string {
  return `你是事实抽取器。从给定的小说文本中抽取结构化事件，输出 JSON：
{"events":[{"kind":"char.create|char.update|char.death|relation.set|fact.set|location.move|item.create|foreshadow.plant|foreshadow.recover","payload":{...},"worldTimeHint":"文中相对时间表达或空"}]}
规则：
- 只抽取文中明确发生的事实，不推测。
- 人物名用文中名字（将作为 id 与 name）。
- relation.set 的 type 用简洁中文（恋人/敌对/师徒/父子…）。
- fact.set 的 key 用 "setting:主题" 格式。
- 世界设定（王朝、地理、规则）用 fact.set。
- 明显为后文埋的悬念用 foreshadow.plant。`;
}

export function adversarialSystemPrompt(): string {
  return `你是对抗审员。给你一条候选事实和它可能冲突的既有事件，判断它入库的风险。
输出 JSON：{"verdict":"normal|conflict|high_impact","reason":"..."}
- conflict：与既有事件直接矛盾（如人物已死又行动、时间倒置）。
- high_impact：改写重大设定/关系（王朝更替、主角死亡、核心关系反转）。
- normal：常规推进。宁可多判 high_impact，不可漏判 conflict。`;
}

export function chatRewritePrompt(opts: { guidance?: string[]; instruction: string; draft: string }): string {
  const lines = [`按作者指令改写下面的草稿。只输出改写后的正文。`, `指令：${opts.instruction}`];
  if (opts.guidance?.length) lines.push(`用户期望：${opts.guidance.join('；')}`);
  lines.push(`\n草稿：\n${opts.draft}`);
  return lines.join('\n');
}
