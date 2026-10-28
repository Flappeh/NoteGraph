// Background replication between the local Dexie DB and the server.
// Cycle: upload pending files -> push dirty rows -> pull changes since cursor.
import { useSyncExternalStore } from 'react'
import type { Table } from 'dexie'
import { api, ApiError } from './api'
import { sessionExpired } from './auth'
import { type Base, type Conflict, type TableName, TABLES, db, nowIso, onLocalChange } from './db'

interface SyncState {
  online: boolean
  syncing: boolean
  lastSync: string | null
  error: string | null
}

let state: SyncState = { online: navigator.onLine, syncing: false, lastSync: null, error: null }
const listeners = new Set<() => void>()
function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  listeners.forEach((f) => f())
}

export function useSyncState() {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => state,
  )
}

const LOCAL_KEYS = ['_dirty', '_base', '_v', '_conflict', 'rev']
const strip = (row: Base) => {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) if (!LOCAL_KEYS.includes(k)) out[k] = v
  return out
}
const tbl = (t: TableName) => db[t] as unknown as Table<Base, string>

let running = false
let again = false

/** Run one sync cycle now (coalesces concurrent calls). */
export async function syncNow() {
  if (!db || !navigator.onLine) return
  if (running) {
    again = true
    return
  }
  running = true
  set({ syncing: true })
  try {
    const run = async () => {
      await uploadFiles()
      await push()
      await pull()
    }
    // Only one tab syncs at a time.
    if (navigator.locks) await navigator.locks.request('notegraph-sync', run)
    else await run()
    set({ lastSync: nowIso(), error: null, online: true })
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) sessionExpired()
    else if (e instanceof TypeError) set({ online: false })
    else set({ error: e instanceof Error ? e.message : String(e) })
  } finally {
    running = false
    set({ syncing: false })
    if (again) {
      again = false
      schedule(500)
    }
  }
}

let timer: number | undefined
function schedule(ms: number) {
  clearTimeout(timer)
  timer = window.setTimeout(syncNow, ms)
}

async function uploadFiles() {
  const pending = await db.blobs.where('uploaded').equals(0).toArray()
  for (const b of pending) {
    const att = await db.attachments.get(b.id)
    if (!att || att.deleted) {
      await db.blobs.delete(b.id) // removed before it was ever uploaded
      continue
    }
    const res = await fetch(`/api/files/${b.id}`, {
      method: 'PUT',
      body: b.blob,
      headers: { 'X-NoteGraph': '1', 'Content-Type': att.mime || 'application/octet-stream' },
      credentials: 'same-origin',
    })
    if (res.status === 401) throw new ApiError(401, 'not signed in')
    if (!res.ok) {
      const msg = await res.json().catch(() => ({ error: res.statusText }))
      throw new ApiError(res.status, `Upload of "${att.filename}" failed: ${msg.error}`)
    }
    await db.blobs.update(b.id, { uploaded: 1 })
  }
}

interface PushResult {
  rev: number
  applied: { table: TableName; id: string; rev: number }[]
  conflicts: { table: TableName; id: string; server: Record<string, unknown> }[]
  rejected: { table: TableName; id: string; error: string }[]
}

async function push() {
  const changes: { table: TableName; id: string; base_rev: number; data: Record<string, unknown>; _v: number }[] = []
  for (const t of TABLES) {
    const rows = await tbl(t).where('_dirty').equals(1).toArray()
    for (const r of rows) {
      if (r._conflict) continue
      // An attachment row is only pushed once its bytes are on the server.
      if (t === 'attachments' && !r.deleted) {
        const b = await db.blobs.get(r.id)
        if (b && !b.uploaded) continue
      }
      changes.push({ table: t, id: r.id, base_rev: r._base, data: strip(r), _v: r._v })
    }
  }
  for (let i = 0; i < changes.length; i += 200) {
    const batch = changes.slice(i, i + 200)
    const res = await api<PushResult>('/api/sync', {
      method: 'POST',
      json: { changes: batch.map(({ _v, ...c }) => c) },
    })
    const sentV = new Map(batch.map((c) => [`${c.table}:${c.id}`, c._v]))
    await db.transaction('rw', [...TABLES.map(tbl), db.conflicts], async () => {
      for (const a of res.applied) {
        const cur = await tbl(a.table).get(a.id)
        if (!cur) continue
        // Edits made while the request was in flight stay dirty.
        const clean = cur._v === sentV.get(`${a.table}:${a.id}`)
        await tbl(a.table).put({ ...cur, rev: a.rev, _base: a.rev, _dirty: clean ? 0 : 1 })
      }
      for (const c of res.conflicts) await markConflict(c.table, c.id, c.server)
      for (const r of res.rejected) {
        console.warn('sync rejected', r)
        await tbl(r.table).update(r.id, { _dirty: 0 })
      }
    })
  }
}

async function markConflict(table: TableName, id: string, server: Record<string, unknown>) {
  await db.conflicts.put({ key: `${table}:${id}`, table, id, server, at: nowIso() })
  await tbl(table).update(id, { _conflict: 1 })
}

async function pull() {
  const cursor = ((await db.meta.get('cursor'))?.value as number) || 0
  const res = await api<{ rev: number; full: boolean; changes: Record<TableName, Base[]> }>(`/api/sync?since=${cursor}`)
  await db.transaction('rw', [...TABLES.map(tbl), db.conflicts, db.meta, db.blobs], async () => {
    for (const t of TABLES) {
      for (const row of res.changes[t] || []) {
        const local = await tbl(t).get(row.id)
        if (local?._dirty) {
          // Our own accepted write echoed back, or a remote edit racing ours.
          if (row.rev !== local._base) await markConflict(t, row.id, row as unknown as Record<string, unknown>)
          continue
        }
        if (row.deleted) {
          await tbl(t).delete(row.id)
          if (t === 'attachments') await db.blobs.delete(row.id)
          continue
        }
        await tbl(t).put({ ...row, _dirty: 0, _base: row.rev, _v: local?._v || 0, _conflict: 0 })
      }
    }
    await db.meta.put({ key: 'cursor', value: res.rev })
  })
}

// --- Conflict resolution ------------------------------------------------------

export type Resolution = 'mine' | 'theirs' | 'both'

export async function resolveConflict(c: Conflict, choice: Resolution) {
  const t = tbl(c.table)
  const server = c.server as unknown as Base
  await db.transaction('rw', [t, db.conflicts], async () => {
    const local = await t.get(c.id)
    if (choice === 'theirs' || !local) {
      if (server.deleted) await t.delete(c.id)
      else await t.put({ ...server, _dirty: 0, _base: server.rev, _v: (local?._v || 0) + 1, _conflict: 0 })
    } else if (choice === 'mine') {
      // Re-base our version on the server's so the next push overwrites it.
      await t.put({ ...local, _base: server.rev, _dirty: 1, _conflict: 0, _v: local._v + 1 })
    } else {
      // Keep both: server version keeps the id, ours becomes a new copy.
      const copy = { ...local, id: crypto.randomUUID(), rev: 0, _base: 0, _dirty: 1 as const, _conflict: 0 as const, _v: 1 }
      if ('title' in copy) (copy as { title: string }).title = `${(copy as { title: string }).title} (conflict copy)`
      if ('name' in copy) (copy as { name: string }).name = `${(copy as { name: string }).name} (conflict copy)`
      await t.add(copy)
      if (server.deleted) await t.delete(c.id)
      else await t.put({ ...server, _dirty: 0, _base: server.rev, _v: local._v + 1, _conflict: 0 })
    }
    await db.conflicts.delete(c.key)
  })
  schedule(300)
}

// --- Lifecycle -------------------------------------------------------------------

let started = false
export function startSync() {
  if (started) return
  started = true
  onLocalChange(() => schedule(1500))
  window.addEventListener('online', () => {
    set({ online: true })
    schedule(200)
  })
  window.addEventListener('offline', () => set({ online: false }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') schedule(200)
  })
  setInterval(() => document.visibilityState === 'visible' && syncNow(), 30_000)
  schedule(0)
}
