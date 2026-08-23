// LLM 双协议适配器：OpenAI Chat Completions + Anthropic Messages + Mock（离线演示用）
// MD 第 6 节：每类任务独立配模型；成本计量回调统一走 usage

export interface LLMMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; toolCallId?: string; name?: string; }
export interface ToolSpec { type: 'function'; function: { name: string; description: string; parameters: any } }
export interface ToolCall { id: string; name: string; arguments: string }
export interface LLMResponse {
  content: string; toolCalls: ToolCall[];
  usage: { inputTokens: number; outputTokens: number };
  model: string; provider: string;
}
export interface ProviderConfig {
  id: string;
  protocol: 'openai' | 'anthropic' | 'mock';
  baseUrl: string;
  apiKey: string;
  model: string;
  role: 'renderer' | 'director' | 'extractor' | 'adversarial' | 'chat';
  maxOutputTokens?: number;
}

const APPROX_CHARS_PER_TOKEN_ZH = 1.6;

export function approxTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN_ZH);
}

export async function callLLM(
  cfg: ProviderConfig,
  messages: LLMMessage[],
  opts: { tools?: ToolSpec[]; temperature?: number; maxTokens?: number; signal?: AbortSignal } = {},
): Promise<LLMResponse> {
  if (cfg.protocol === 'mock') return mockCall(cfg, messages, opts);
  if (cfg.protocol === 'openai') return openaiCall(cfg, messages, opts);
  return anthropicCall(cfg, messages, opts);
}

// ---------- OpenAI Chat Completions ----------
async function openaiCall(cfg: ProviderConfig, messages: LLMMessage[], opts: any): Promise<LLMResponse> {
  const body: any = {
    model: cfg.model,
    messages: messages.map(m => m.role === 'tool'
      ? { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
      : { role: m.role, content: m.content }),
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? cfg.maxOutputTokens ?? 4096,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = 'auto';
  }
  const res = await fetch(joinUrl(cfg.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const msg = j.choices?.[0]?.message ?? {};
  return {
    content: msg.content ?? '',
    toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function.name, arguments: t.function.arguments })),
    usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 },
    model: cfg.model, provider: cfg.id,
  };
}

// ---------- Anthropic Messages ----------
async function anthropicCall(cfg: ProviderConfig, messages: LLMMessage[], opts: any): Promise<LLMResponse> {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const convo = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const body: any = {
    model: cfg.model, system: sys || undefined, messages: convo,
    max_tokens: opts.maxTokens ?? cfg.maxOutputTokens ?? 4096,
    temperature: opts.temperature ?? 0.8,
  };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t: ToolSpec) => ({
      name: t.function.name, description: t.function.description, input_schema: t.function.parameters,
    }));
  }
  const res = await fetch(joinUrl(cfg.baseUrl, '/messages'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j: any = await res.json();
  const text = (j.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
  const toolCalls = (j.content ?? []).filter((c: any) => c.type === 'tool_use')
    .map((c: any) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.input ?? {}) }));
  return {
    content: text, toolCalls,
    usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
    model: cfg.model, provider: cfg.id,
  };
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b) || /\/messages$/.test(b)) return b;
  return b + path;
}

// ---------- Mock：无 Key 时的离线演示引擎 ----------
/** mock provider 支持「脚本注入」：server 可注册按 prompt 关键词命中的 canned 响应，用于演示/测试 */
export const mockScripts: Array<{ match: RegExp; content: string; toolCalls?: ToolCall[] }> = [];

function mockCall(cfg: ProviderConfig, messages: LLMMessage[], opts: any): LLMResponse {
  const sys = messages.find(m => m.role === 'system')?.content ?? '';
  const last = messages[messages.length - 1]?.content ?? '';
  const all = messages.map(m => m.content).join('\n');
  for (const s of mockScripts) {
    if (s.match.test(all) || s.match.test(last)) {
      return { content: s.content, toolCalls: s.toolCalls ?? [], usage: { inputTokens: approxTokens(all), outputTokens: approxTokens(s.content) }, model: cfg.model, provider: 'mock' };
    }
  }
  // 按 system prompt 角色分流（渲染/导演/抽取/对抗审/默认对话）
  let content: string;
  if (/执笔者|渲染|正文|改写/.test(sys)) {
    content = '她盯着那封没有署名的信，指节因用力而发白。\n"你知道我为什么回来。"\n窗外传来更夫的梆子声。三更了。烛火矮下去半寸，她没有去剪。';
  } else if (/导演/.test(sys)) {
    const mustBreak = sys.includes('mustBreak 必须为 true');
    content = JSON.stringify({
      beats: mustBreak
        ? ['意外来客打断对话，局势骤变', '旧秘密被迫揭出一角，双方各自承受代价']
        : ['主角亮出筹码，试探对方底线', '对方给出意外的回应，关系出现松动'],
      mustBreak, tension: mustBreak ? 0.8 : 0.55,
      options: ['追问道："你到底瞒了我什么"', '沉默地把信推过去', '转身离开，留一句狠话'],
    });
  } else if (/抽取/.test(sys)) {
    const hasChars = /沈青|林澜/.test(last);
    content = JSON.stringify({
      events: hasChars
        ? [{ kind: 'location.move', payload: { charId: '林澜', place: '北壤·质子府' }, worldTimeHint: '' },
           { kind: 'foreshadow.plant', payload: { id: `f-${Date.now().toString(36)}`, description: '密信中提及的南川布防图下落', deadlineWorldTime: null }, worldTimeHint: '' }]
        : [],
    });
  } else if (/对抗审/.test(sys)) {
    content = JSON.stringify({ verdict: 'normal', reason: '常规推进（mock）' });
  } else {
    content = '（离线演示模式）这取决于你的世界事件流。在设置页配置任意 OpenAI 协议端点后，这里就是真实的模型回复。';
  }
  return { content, toolCalls: [], usage: { inputTokens: approxTokens(all), outputTokens: approxTokens(content) }, model: cfg.model, provider: 'mock' };
}

/** 从模型回复里稳健抽取 JSON（fenced / 裸对象 / 括号扫描，收 Scriverse 容错策略） */
export function extractJson(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const tryParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };
  if (fenced) { const v = tryParse(fenced[1].trim()); if (v) return v; }
  const direct = tryParse(text.trim()); if (direct) return direct;
  const start = text.search(/[{[]/);
  if (start >= 0) {
    for (let end = text.length; end > start; end--) {
      const v = tryParse(text.slice(start, end));
      if (v && typeof v === 'object') return v;
    }
  }
  return null;
}
