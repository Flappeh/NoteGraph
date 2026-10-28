export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** JSON fetch against our API. Throws ApiError for HTTP errors, TypeError when offline. */
export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('X-NoteGraph', '1')
  let body = init.body
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(init.json)
  }
  const res = await fetch(path, { ...init, headers, body, credentials: 'same-origin' })
  if (!res.ok) {
    let msg = res.statusText
    try {
      msg = (await res.json()).error || msg
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}
