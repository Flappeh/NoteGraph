import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'wouter'
import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronRight, Columns3, FolderOpen, List, Plus, Trash2 } from 'lucide-react'
import { childIndex, createNote } from '../actions'
import { db, removeNoteTree, update, type Note, type Status } from '../db'
import { useAllNotes, useLocalState, useStatusMap } from '../hooks'
import { ColorPicker, DateChip, EmptyState, StatusChip } from '../components/ui'
import { NoteCard } from './NotePage'

type SortKey = 'manual' | 'date' | 'title' | 'updated'

export function TopicPage({ id }: { id: string }) {
  const topic = useLiveQuery(() => db.topics.get(id), [id])
  const allNotes = useAllNotes()
  const { categories, statuses, status } = useStatusMap()
  const [, navigate] = useLocation()
  const [params] = useSearchParams()
  const [view, setView] = useLocalState<'list' | 'board'>(`ng_topic_view_${id}`, 'list')
  const [sort, setSort] = useLocalState<SortKey>('ng_topic_sort', 'manual')
  const [boardCat, setBoardCat] = useLocalState<string>(`ng_board_cat_${id}`, '')
  const [collapsed, setCollapsed] = useLocalState<Record<string, boolean>>('ng_outline_collapsed', {})
  const toggle = (nid: string) => setCollapsed({ ...collapsed, [nid]: !collapsed[nid] })

  const notes = useMemo(() => allNotes.filter((n) => n.topic_id === id), [allNotes, id])
  const kids = useMemo(() => childIndex(notes), [notes])

  if (topic === undefined || (topic && topic.id !== id)) return <div className="page"><div className="muted">Loading…</div></div>
  if (!topic || topic.deleted) {
    return (
      <div className="page">
        <EmptyState icon={<FolderOpen size={32} />} title="Topic not found"><Link href="/" className="btn">Go home</Link></EmptyState>
      </div>
    )
  }

  const addNote = async () => {
    const n = await createNote(id, null)
    navigate(`/note/${n.id}?edit=1`)
  }
  const del = async () => {
    if (!confirm(`Delete topic "${topic.name}" and all ${notes.length} note(s) in it?`)) return
    for (const n of notes.filter((n) => !n.parent_id || !notes.some((p) => p.id === n.parent_id))) await removeNoteTree(n.id)
    await update('topics', id, { deleted: true })
    navigate('/')
  }
  const sorter = (a: Note, b: Note) =>
    sort === 'title' ? a.title.localeCompare(b.title)
      : sort === 'date' ? (a.date_start ?? '9999').localeCompare(b.date_start ?? '9999')
        : sort === 'updated' ? b.updated_at.localeCompare(a.updated_at)
          : a.sort - b.sort || a.created_at.localeCompare(b.created_at)

  const doneStatuses = new Set(statuses.filter((s) => s.done).map((s) => s.id))
  const withStatus = notes.filter((n) => n.status_id)
  const done = withStatus.filter((n) => doneStatuses.has(n.status_id!)).length
  const activeCat = boardCat || topic.default_category_id || categories[0]?.id || ''

  return (
    <div className="page">
      <div className="topic-head" style={{ borderColor: topic.color }}>
        <IconInput value={topic.icon} color={topic.color} fallback={topic.name.slice(0, 1).toUpperCase()} onChange={(icon) => update('topics', id, { icon })} />
        <NameInput value={topic.name} autoFocus={params.get('rename') === '1'} onSave={(name) => update('topics', id, { name })} />
        <div className="note-actions">
          <ColorPicker value={topic.color} onChange={(color) => update('topics', id, { color })} allowNone={false} />
          <button className="icon-btn danger" onClick={del} title="Delete topic"><Trash2 size={18} /></button>
        </div>
      </div>

      <div className="topic-stats">
        <span>{notes.length} note{notes.length === 1 ? '' : 's'}</span>
        {withStatus.length > 0 && (
          <span className="progress-inline" title={`${done} of ${withStatus.length} done`}>
            <span className="progress"><span style={{ width: `${(done / withStatus.length) * 100}%`, background: topic.color }} /></span>
            {done}/{withStatus.length} done
          </span>
        )}
        <label className="inline-field">
          Default status category
          <select className="select" value={topic.default_category_id ?? ''} onChange={(e) => update('topics', id, { default_category_id: e.target.value || null })}>
            <option value="">None</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>

      <div className="toolbar-row">
        <div className="seg">
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}><List size={15} /> List</button>
          <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><Columns3 size={15} /> Board</button>
        </div>
        {view === 'list' ? (
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
            <option value="manual">Sort: created</option>
            <option value="date">Sort: date</option>
            <option value="title">Sort: title</option>
            <option value="updated">Sort: last edited</option>
          </select>
        ) : (
          <select className="select" value={activeCat} onChange={(e) => setBoardCat(e.target.value)} aria-label="Board category">
            {categories.map((c) => <option key={c.id} value={c.id}>Board: {c.name}</option>)}
          </select>
        )}
        <span className="spacer" />
        <button className="btn primary" onClick={addNote}><Plus size={16} /> New note</button>
      </div>

      {notes.length === 0 ? (
        <EmptyState icon={<FolderOpen size={32} />} title="No notes in this topic yet">
          <button className="btn primary" onClick={addNote}><Plus size={16} /> Create the first note</button>
        </EmptyState>
      ) : view === 'list' ? (
        <div className="outline">
          <Outline parentKey={`topic:${id}`} kids={kids} status={status} sorter={sorter} depth={0} collapsed={collapsed} toggle={toggle} />
        </div>
      ) : (
        <Board notes={notes} statuses={statuses.filter((s) => s.category_id === activeCat)} categoryId={activeCat} status={status} />
      )}
    </div>
  )
}

interface OutlineProps {
  parentKey: string
  kids: Map<string | null, Note[]>
  status: Map<string, Status>
  sorter: (a: Note, b: Note) => number
  depth: number
  collapsed: Record<string, boolean>
  toggle: (id: string) => void
}

function Outline(props: OutlineProps) {
  const { parentKey, kids, status, sorter, depth, collapsed, toggle } = props
  const list = [...(kids.get(parentKey) || [])].sort(sorter)
  return (
    <>
      {list.map((n) => {
        const children = kids.get(n.id) || []
        const isCollapsed = collapsed[n.id]
        return (
          <div key={n.id} className="outline-item" style={{ marginLeft: depth * 22 }}>
            <div className="outline-row" style={{ borderLeftColor: n.color || 'var(--border-strong)' }}>
              <button className={`twisty${children.length ? '' : ' hidden'}${isCollapsed ? '' : ' open'}`} onClick={() => toggle(n.id)}>
                <ChevronRight size={14} />
              </button>
              <Link href={`/note/${n.id}`} className="outline-title">{n.title || 'Untitled'}</Link>
              <span className="outline-meta">
                <DateChip start={n.date_start} end={n.date_end} />
                <StatusChip status={n.status_id ? status.get(n.status_id) : undefined} small />
                {children.length > 0 && <span className="muted small">{children.length} ↳</span>}
              </span>
            </div>
            {!isCollapsed && children.length > 0 && <Outline {...props} parentKey={n.id} depth={1} />}
          </div>
        )
      })}
    </>
  )
}

/** Kanban of notes by status within one category. Drag cards to change status. */
function Board({ notes, statuses, categoryId, status }: { notes: Note[]; statuses: Status[]; categoryId: string; status: Map<string, Status> }) {
  const [over, setOver] = useState<string | null>(null)
  if (!categoryId) return <p className="muted">Create a status category first (Statuses menu).</p>
  const inCat = notes.filter((n) => n.status_category_id === categoryId || (n.status_id && status.get(n.status_id)?.category_id === categoryId))
  const columns: { id: string; name: string; color: string }[] = [{ id: '', name: 'No status', color: '#94a3b8' }, ...statuses]
  const drop = (colId: string, noteId: string) => update('notes', noteId, { status_category_id: categoryId, status_id: colId || null })
  return (
    <>
      <p className="muted small">Showing notes that use this status category. Drag a card to another column to change its status.</p>
      <div className="board">
        {columns.map((col) => {
          const cards = inCat.filter((n) => (n.status_id ?? '') === col.id || (col.id === '' && n.status_id && !statuses.some((s) => s.id === n.status_id)))
          return (
            <div
              key={col.id || 'none'}
              className={`board-col${over === col.id ? ' over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setOver(col.id) }}
              onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); drop(col.id, e.dataTransfer.getData('text/note-id')) }}
            >
              <div className="board-col-head"><span className="dot" style={{ background: col.color }} />{col.name}<span className="count">{cards.length}</span></div>
              {cards.map((n) => (
                <div key={n.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/note-id', n.id)}>
                  <NoteCard note={n} compact />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </>
  )
}

function NameInput({ value, onSave, autoFocus }: { value: string; onSave: (v: string) => void; autoFocus?: boolean }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => setV(value), [value])
  useEffect(() => {
    if (autoFocus) ref.current?.select()
  }, [autoFocus])
  return (
    <input
      ref={ref}
      className="topic-name-input"
      value={v}
      placeholder="Topic name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function IconInput({ value, color, fallback, onChange }: { value: string; color: string; fallback: string; onChange: (v: string) => void }) {
  return (
    <input
      className="topic-icon big"
      style={{ background: color }}
      value={value}
      placeholder={fallback}
      maxLength={4}
      title="Icon: type an emoji or letters"
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
