import { ref } from 'vue';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Set when any call returns 401 — the router sends the user to the login page. */
export const sessionExpired = ref(false);

export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: opts.body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: 'same-origin',
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && !path.startsWith('/login') && !path.startsWith('/kid'))
    sessionExpired.value = true;
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}
