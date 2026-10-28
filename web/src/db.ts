// Local IndexedDB (Dexie) store. Every UI read and write goes here first; the
// sync engine replicates dirty rows to the server in the background.
import Dexie, { type Table } from 'dexie'
import type { JSONContent } from '@tiptap/core'

export type TableName = 'status_categories' | 'statuses' | 'topics' | 'notes' | 'attachments'
export const TABLES: TableName[] = ['status_categories', 'statuses', 'topics', 'notes', 'attachments']

/** Fields kept only on this device. */
export interface Local {
  _dirty: 0 | 1 // has local changes not yet accepted by the server
  _base: number // server rev this local copy is based on (0 = never synced)
  _v: number // local edit counter, guards against edits made during a push
  _conflict?: 0 | 1 // server has a different version; waiting for the user
}

export interface Base extends Local {
  id: string
  rev: number
  deleted: boolean
  sort: number
  created_at: string
  updated_at: string
}

export interface StatusCategory extends Base {
  name: string
  color: string
}

export interface Status extends Base {
  category_id: string | null
  name: string
  color: string
  done: boolean
}

export interface Topic extends Base {
  name: string
  color: string
  icon: string
  default_category_id: string | null
}

export interface Note extends Base {
  topic_id: string | null
  parent_id: string | null
  title: string
  content: JSONContent | null
  content_text: string
  links: string[]
  color: string
  status_category_id: string | null
  status_id: string | null
  date_start: string | null // YYYY-MM-DD
  date_end: string | null
}

export interface Attachment extends Base {
  note_id: string | null
  filename: string
  mime: string
  size: number
  inline: boolean
}

export interface BlobRow {
  id: string
  blob: Blob
  uploaded: 0 | 1
}

export interface Conflict {
  key: string // `${table}:${id}`
  table: TableName
  id: string
  server: Record<string, unknown>
  at: string
}

export interface Meta {
  key: string
  value: unknown
}

export type RowOf<T extends TableName> = T extends 'status_categories'
  ? StatusCategory
  : T extends 'statuses'
    ? Status
    : T extends 'topics'
      ? Topic
      : T extends 'notes'
        ? Note
        : Attachment

class NoteGraphDB extends Dexie {
  status_categories!: Table<StatusCategory, string>
  statuses!: Table<Status, string>
  topics!: Table<Topic, string>
  notes!: Table<Note, string>
  attachments!: Table<Attachment, string>
  blobs!: Table<BlobRow, string>
  conflicts!: Table<Conflict, string>
  meta!: Table<Meta, string>

  constructor(name: string) {
    super(name)
    this.version(1).stores({
      status_categories: 'id, _dirty',
      statuses: 'id, category_id, _dirty',
      topics: 'id, _dirty',
      notes: 'id, topic_id, parent_id, status_id, _dirty, updated_at',
      attachments: 'id, note_id, _dirty',
      blobs: 'id, uploaded',
      conflicts: 'key',
      meta: 'key',
    })
  }
}

/** The database of the signed-in user. Each account gets its own database. */
export let db: NoteGraphDB = null!

export function openUserDb(userId: string) {
  if (db?.name === dbName(userId)) return db
  db?.close()
  db = new NoteGraphDB(dbName(userId))
  return db
}

const dbName = (userId: string) => `notegraph_${userId}`

export async function deleteUserDb(userId: string) {
  if (db?.name === dbName(userId)) db.close()
  await Dexie.delete(dbName(userId))
}

// --- Writes -----------------------------------------------------------------

type Listener = () => void
const changeListeners = new Set<Listener>()
/** Called after every local write; the sync engine uses it to schedule a push. */
export function onLocalChange(fn: Listener) {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}

export const uuid = () => crypto.randomUUID()
export const nowIso = () => new Date().toISOString()

const blank = (): Omit<Base, 'id'> => ({
  rev: 0,
  deleted: false,
  sort: Date.now(),
  created_at: nowIso(),
  updated_at: nowIso(),
  _dirty: 1,
  _base: 0,
  _v: 1,
})

/** Insert a new row. Missing fields get table-appropriate defaults. */
export async function create<T extends TableName>(table: T, fields: Partial<RowOf<T>>): Promise<RowOf<T>> {
  const row = { ...defaults[table](), ...blank(), id: uuid(), ...fields } as RowOf<T>
  await (db[table] as Table<RowOf<T>, string>).add(row)
  changeListeners.forEach((f) => f())
  return row
}

/** Patch an existing row and mark it for sync. */
export async function update<T extends TableName>(table: T, id: string, patch: Partial<RowOf<T>>) {
  const t = db[table] as unknown as Table<Base, string>
  await db.transaction('rw', t, async () => {
    const cur = await t.get(id)
    if (!cur) return
    await t.put({ ...cur, ...patch, updated_at: nowIso(), _dirty: 1, _v: (cur._v || 0) + 1 } as Base)
  })
  changeListeners.forEach((f) => f())
}

/** Tombstone a row; the server keeps it so other devices learn about the delete. */
export const remove = (table: TableName, id: string) => update(table, id, { deleted: true } as never)

/** Delete a note together with its descendants and attachments. */
export async function removeNoteTree(id: string) {
  const ids = await descendantIds(id)
  ids.unshift(id)
  for (const nid of ids) {
    await remove('notes', nid)
    const atts = await db.attachments.where('note_id').equals(nid).toArray()
    for (const a of atts) await remove('attachments', a.id)
  }
}

export async function descendantIds(id: string): Promise<string[]> {
  const out: string[] = []
  const queue = [id]
  while (queue.length) {
    const kids = await db.notes.where('parent_id').equals(queue.shift()!).toArray()
    for (const k of kids) {
      if (k.deleted || out.includes(k.id)) continue
      out.push(k.id)
      queue.push(k.id)
    }
  }
  return out
}

const defaults: { [T in TableName]: () => Partial<RowOf<T>> } = {
  status_categories: () => ({ name: '', color: '#6366f1' }),
  statuses: () => ({ category_id: null, name: '', color: '#94a3b8', done: false }),
  topics: () => ({ name: '', color: '#6366f1', icon: '', default_category_id: null }),
  notes: () => ({
    topic_id: null,
    parent_id: null,
    title: '',
    content: null,
    content_text: '',
    links: [],
    color: '',
    status_category_id: null,
    status_id: null,
    date_start: null,
    date_end: null,
  }),
  attachments: () => ({ note_id: null, filename: '', mime: 'application/octet-stream', size: 0, inline: false }),
}

/** Live rows exclude tombstones. */
export const alive = <T extends { deleted: boolean }>(rows: T[]) => rows.filter((r) => !r.deleted)

export const bySort = <T extends { sort: number; created_at: string }>(a: T, b: T) =>
  a.sort - b.sort || a.created_at.localeCompare(b.created_at)

// --- Attachment bytes -----------------------------------------------------------

/** Store a file locally and create its attachment row; upload happens on sync. */
export async function addAttachment(noteId: string, file: File, inline: boolean) {
  const id = uuid()
  await db.blobs.put({ id, blob: file, uploaded: 0 })
  return create('attachments', {
    id,
    note_id: noteId,
    filename: file.name || (inline ? 'image.png' : 'file'),
    mime: file.type || 'application/octet-stream',
    size: file.size,
    inline,
  })
}

const urlCache = new Map<string, string>()

/** Object URL for an attachment, from the local cache or downloaded (and cached). */
export async function attachmentUrl(id: string): Promise<string | null> {
  const hit = urlCache.get(id)
  if (hit) return hit
  let row = await db.blobs.get(id)
  if (!row) {
    try {
      const res = await fetch(`/api/files/${id}`, { credentials: 'same-origin' })
      if (!res.ok) return null
      row = { id, blob: await res.blob(), uploaded: 1 }
      await db.blobs.put(row)
    } catch {
      return null // offline and not cached
    }
  }
  const url = URL.createObjectURL(row.blob)
  urlCache.set(id, url)
  return url
}
