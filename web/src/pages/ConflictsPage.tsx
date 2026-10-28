import { useLiveQuery } from 'dexie-react-hooks'
import { CheckCircle2, Copy, Laptop, Server } from 'lucide-react'
import { db, type Conflict } from '../db'
import { useStatusMap } from '../hooks'
import { resolveConflict, type Resolution } from '../sync'
import { EmptyState } from '../components/ui'
import { formatRange, timeAgo } from '../util'

const LABEL: Record<string, string> = {
  notes: 'Note', topics: 'Topic', statuses: 'Status', status_categories: 'Status category', attachments: 'Attachment',
}

/** The same item was changed here and on another device: let the user pick. */
export function ConflictsPage() {
  const conflicts = useLiveQuery(() => db.conflicts.toArray(), []) ?? []
  return (
    <div className="page narrow">
      <h1>Sync conflicts</h1>
      <p className="muted">
        These items were changed on this device and on another device before they could sync.
        Choose which version to keep.
      </p>
      {conflicts.length === 0 && <EmptyState icon={<CheckCircle2 size={32} />} title="No conflicts" />}
      {conflicts.map((c) => <ConflictCard key={c.key} c={c} />)}
    </div>
  )
}

function ConflictCard({ c }: { c: Conflict }) {
  const local = useLiveQuery(() => (db[c.table] as unknown as { get(id: string): Promise<Record<string, unknown> | undefined> }).get(c.id), [c.key])
  const { status } = useStatusMap()
  const server = c.server
  const name = (r?: Record<string, unknown>) => (r?.title ?? r?.name ?? r?.filename ?? 'Untitled') as string

  const describe = (r?: Record<string, unknown>) => {
    if (!r) return <p className="muted">Missing on this device</p>
    if (r.deleted) return <p className="danger-text">Deleted</p>
    const rows: [string, string][] = []
    if ('title' in r) rows.push(['Title', String(r.title || 'Untitled')])
    if ('name' in r) rows.push(['Name', String(r.name)])
    if ('status_id' in r) rows.push(['Status', r.status_id ? status.get(r.status_id as string)?.name ?? '—' : '—'])
    if ('date_start' in r) rows.push(['Date', formatRange(r.date_start as string, r.date_end as string) || '—'])
    if ('color' in r) rows.push(['Colour', String(r.color || '—')])
    rows.push(['Edited', timeAgo(r.updated_at as string)])
    return (
      <>
        <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        {'content_text' in r && <div className="conflict-text">{String(r.content_text || '').slice(0, 600) || <span className="muted">(empty)</span>}</div>}
      </>
    )
  }

  const pick = (r: Resolution) => resolveConflict(c, r)
  return (
    <section className="panel conflict">
      <h2>{LABEL[c.table] ?? c.table}: {name(local ?? server)}</h2>
      <div className="conflict-cols">
        <div className="conflict-side">
          <h3><Laptop size={16} /> This device</h3>
          {describe(local)}
          <button className="btn primary" onClick={() => pick('mine')}>Keep this device's version</button>
        </div>
        <div className="conflict-side">
          <h3><Server size={16} /> Other device (server)</h3>
          {describe(server)}
          <button className="btn primary" onClick={() => pick('theirs')}>Keep other device's version</button>
        </div>
      </div>
      {c.table === 'notes' && local && !server.deleted && (
        <button className="btn ghost" onClick={() => pick('both')}><Copy size={15} /> Keep both (save this device's version as a copy)</button>
      )}
    </section>
  )
}
