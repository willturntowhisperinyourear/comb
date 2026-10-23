function failure(res: Response, body: any): Error {
  const message = body?.error?.message ?? body?.error ?? `${res.status} ${res.statusText}`;
  return new Error(typeof message === 'string' ? message : JSON.stringify(message));
}

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw failure(res, body);
  return body as T;
}

/** Multipart upload; the browser sets the boundary, so no content-type here. */
export async function postForm<T = any>(path: string, form: FormData): Promise<T> {
  const res = await fetch('/api' + path, { method: 'POST', body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw failure(res, body);
  return body as T;
}

export const api = {
  get: <T = any>(path: string) => request<T>(path),
  post: <T = any>(path: string, body: unknown = {}) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T = any>(path: string, body: unknown = {}) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T = any>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const copy = (text: string) => navigator.clipboard?.writeText(text);

export const pct = (ok: number, total: number) => (total ? Math.round((ok / total) * 100) : 0);
export const ms = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`);
export const when = (ts: number | string) => {
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
