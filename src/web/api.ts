import type { ClientMessage, ServerMessage } from '../shared/types.js';

/**
 * Thin client for the local server. The launch token is read once from the
 * page URL and attached to every request; the UI never sees it otherwise.
 */
const token = new URLSearchParams(location.search).get('t') ?? '';

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>,
): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { 'x-bgcm-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
  get: <T>(path: string, query?: Record<string, string>) =>
    request<T>('GET', path, undefined, query),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  del: <T>(path: string, body: unknown) => request<T>('DELETE', path, body),
};

/**
 * WebSocket connection with automatic reconnect. Server messages fan out to
 * every registered handler; the reconnect replays server state on its own
 * because the server resends a snapshot on each connect.
 */
export class Socket {
  private ws: WebSocket | null = null;
  private handlers = new Set<(m: ServerMessage) => void>();
  private onOpenHandlers = new Set<() => void>();
  private retry = 500;

  connect(): void {
    const url = new URL('/ws', location.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('t', token);
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 500;
      for (const h of this.onOpenHandlers) h();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as ServerMessage;
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10_000);
    };
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(h: (m: ServerMessage) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  onOpen(h: () => void): () => void {
    this.onOpenHandlers.add(h);
    return () => this.onOpenHandlers.delete(h);
  }
}

export const socket = new Socket();
