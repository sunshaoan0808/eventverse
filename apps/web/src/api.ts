// API 客户端：普通请求 + POST SSE 流式（fetch reader 解析）
export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j as any).error ?? `HTTP ${r.status}`);
  return j as T;
}

export interface SseEvent { event: string; data: any }

/** POST SSE 流式：网络中断自动重试一次（回合幂等，MD §8 弱网纪律） */
export async function postSse(path: string, body: any, onEvent: (e: SseEvent) => void, opts: { retries?: number } = {}): Promise<void> {
  const attempts = (opts.retries ?? 1) + 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await postSseOnce(path, body, onEvent);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

async function postSseOnce(path: string, body: any, onEvent: (e: SseEvent) => void): Promise<void> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    const j = await r.json().catch(() => ({ error: r.status }));
    throw new Error((j as any).error ?? `HTTP ${r.status}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evLine = block.split('\n').find(l => l.startsWith('event: '));
      const dataLine = block.split('\n').find(l => l.startsWith('data: '));
      if (evLine && dataLine) {
        let data: any = dataLine.slice(6);
        try { data = JSON.parse(data); } catch { /* plain */ }
        onEvent({ event: evLine.slice(7), data });
      }
    }
  }
}
