import { create, db, type Note } from './db'
import { PALETTE } from './util'

export async function createTopic(name = 'New topic') {
  const count = await db.topics.count()
  return create('topics', { name, color: PALETTE[(count * 5) % PALETTE.length] })
}

/** New note inheriting colour and status category from its parent or topic. */
export async function createNote(topicId: string | null, parentId: string | null = null, title = ''): Promise<Note> {
  const parent = parentId ? await db.notes.get(parentId) : undefined
  const topic = topicId ? await db.topics.get(topicId) : undefined
  return create('notes', {
    topic_id: topicId,
    parent_id: parentId,
    title,
    color: parent?.color || topic?.color || '',
    status_category_id: parent?.status_category_id ?? topic?.default_category_id ?? null,
  })
}

/** Build parent -> children index for a list of notes. */
export function childIndex(notes: Note[]) {
  const map = new Map<string | null, Note[]>()
  const ids = new Set(notes.map((n) => n.id))
  for (const n of notes) {
    // Notes whose parent is gone are shown at the topic root.
    const key = n.parent_id && ids.has(n.parent_id) ? n.parent_id : `topic:${n.topic_id}`
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(n)
  }
  for (const list of map.values()) list.sort((a, b) => a.sort - b.sort || a.created_at.localeCompare(b.created_at))
  return map
}
