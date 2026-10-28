import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useSearchParams } from 'wouter'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  CalendarPlus, CornerDownRight, Download, Eye, File as FileIcon, FileImage, FileText, FolderInput, Link2,
  Paperclip, Pencil, Plus, Trash2, Upload, X, CloudUpload,
} from 'lucide-react'
import { childIndex, createNote } from '../actions'
import {
  addAttachment, alive, attachmentUrl, db, descendantIds, remove, removeNoteTree, update, type Note,
} from '../db'
import { NoteEditor } from '../editor/Editor'
import { useAllNotes, useStatusMap, useTopics } from '../hooks'
import { ColorPicker, DateChip, EmptyState, Modal, StatusChip, StatusPicker } from '../components/ui'
import { formatSize, todayIso, tint } from '../util'

export function NotePage({ id }: { id: string }) {
  const note = useLiveQuery(() => db.notes.get(id), [id])
  const [, navigate] = useLocation()
  const [params, setParams] = useSearchParams()
  const editing = params.get('edit') === '1'
  const setEditing = (on: boolean) => setParams(on ? { edit: '1' } : {}, { replace: true })

  const topics = useTopics()
  const allNotes = useAllNotes()
  const { categories, statuses, status } = useStatusMap()
  const attachments = useLiveQuery(async () => alive(await db.attachments.where('note_id').equals(id).toArray()), [id]) ?? []
  const pendingBlobs = useLiveQuery(async () => new Set((await db.blobs.where('uploaded').equals(0).primaryKeys()) as string[]), []) ?? new Set<string>()
  const [moving, setMoving] = useState(false)

  const kids = useMemo(() => childIndex(allNotes), [allNotes])
  const children = kids.get(id) || []
  const backlinks = allNotes.filter((n) => n.id !== id && n.links.includes(id))
  const outlinks = note ? allNotes.filter((n) => note.links.includes(n.id)) : []

  const linkOpts = useMemo(
    () => ({
      search: (q: string) => {
        const s = q.toLowerCase()
        return allNotesRef.current
          .filter((n) => n.id !== id && (n.title || 'Untitled').toLowerCase().includes(s))
          .map((n) => ({ id: n.id, title: n.title || 'Untitled' }))
      },
      createNote: async (title: string) => (await createNote(noteRef.current?.topic_id ?? null, null, title)).id,
      open: (nid: string) => navigateRef.current(`/note/${nid}`),
    }),
    [id],
  )
  const allNotesRef = useRef(allNotes)
  allNotesRef.current = allNotes
  const noteRef = useRef(note)
  noteRef.current = note
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  const onFiles = useCallback(
    async (files: File[], inline: boolean) => {
      const ids: string[] = []
      for (const f of files) ids.push((await addAttachment(id, f, inline)).id)
      return ids
    },
    [id],
  )

  // useLiveQuery briefly returns the previous note after navigation; never
  // render (and let the editor save) another note's data under this id.
  if (note === undefined || (note && note.id !== id)) return <div className="page"><div className="muted">Loading…</div></div>
  if (!note || note.deleted) {
    return (
      <div className="page">
        <EmptyState icon={<FileText size={32} />} title="Note not found">
          <p className="muted">It may have been deleted on another device.</p>
          <Link href="/" className="btn">Go home</Link>
        </EmptyState>
      </div>
    )
  }

  const topic = topics.find((t) => t.id === note.topic_id)
  const crumbs: Note[] = []
  for (let p = note.parent_id ? allNotes.find((n) => n.id === note.parent_id) : undefined; p && crumbs.length < 20; p = allNotes.find((n) => n.id === p!.parent_id)) {
    crumbs.unshift(p)
  }
  const set = (patch: Partial<Note>) => update('notes', id, patch)

  const del = async () => {
    const n = (await descendantIds(id)).length
    if (!confirm(`Delete "${note.title || 'Untitled'}"${n ? ` and its ${n} child note${n > 1 ? 's' : ''}` : ''}?`)) return
    await removeNoteTree(id)
    navigate(note.parent_id ? `/note/${note.parent_id}` : topic ? `/topic/${topic.id}` : '/')
  }

  return (
    <div className="page note-page" style={{ ['--note-color' as string]: note.color || 'var(--accent)' }}>
      <div className="note-accent" style={{ background: note.color || 'transparent' }} />
      <div className="crumbs">
        {topic && (
          <Link href={`/topic/${topic.id}`} className="crumb">
            <span className="topic-icon xs" style={{ background: topic.color }}>{topic.icon || topic.name.slice(0, 1)}</span>
            {topic.name || 'Untitled topic'}
          </Link>
        )}
        {crumbs.map((c) => (
          <span key={c.id}>
            <span className="crumb-sep">/</span>
            <Link href={`/note/${c.id}`} className="crumb">{c.title || 'Untitled'}</Link>
          </span>
        ))}
      </div>

      <div className="note-head">
        {editing ? (
          <TitleInput note={note} onSave={(title) => set({ title })} />
        ) : (
          <h1 className="note-title" onDoubleClick={() => setEditing(true)}>{note.title || <span className="muted">Untitled</span>}</h1>
        )}
        <div className="note-actions">
          <button className={`btn ${editing ? 'primary' : ''}`} onClick={() => setEditing(!editing)} title={editing ? 'Switch to view mode' : 'Switch to edit mode'}>
            {editing ? <><Eye size={16} /> View</> : <><Pencil size={16} /> Edit</>}
          </button>
          <button className="icon-btn" onClick={() => setMoving(true)} title="Move note"><FolderInput size={18} /></button>
          <button className="icon-btn danger" onClick={del} title="Delete note"><Trash2 size={18} /></button>
        </div>
      </div>

      <div className="meta-bar">
        <div className="meta-item">
          <span className="meta-label">Status</span>
          <StatusPicker
            categories={categories}
            statuses={statuses}
            categoryId={note.status_category_id}
            statusId={note.status_id}
            onChange={(c, s) => set({ status_category_id: c, status_id: s })}
          />
        </div>
        <div className="meta-item">
          <span className="meta-label">Date</span>
          <DateFields note={note} onChange={set} />
        </div>
        <div className="meta-item">
          <span className="meta-label">Colour</span>
          <ColorPicker value={note.color} onChange={(color) => set({ color })} label={note.color ? 'Change' : 'None'} />
        </div>
      </div>

      <NoteEditor
        key={id}
        noteId={id}
        content={note.content}
        editable={editing}
        onChange={(content, content_text, links) => set({ content, content_text, links })}
        onFiles={onFiles}
        links={linkOpts}
      />
      {!editing && !note.content_text.trim() && !note.content?.content?.some((n) => n.type === 'image') && (
        <button className="empty-note" onClick={() => setEditing(true)}>Empty note — click to start writing</button>
      )}

      <Attachments attachments={attachments} pending={pendingBlobs} onFiles={onFiles} />

      <section className="section">
        <div className="section-head">
          <h2><CornerDownRight size={17} /> Child notes {children.length > 0 && <span className="count">{children.length}</span>}</h2>
          <button
            className="btn small"
            onClick={async () => {
              const n = await createNote(note.topic_id, id)
              navigate(`/note/${n.id}?edit=1`)
            }}
          >
            <Plus size={15} /> Add child
          </button>
        </div>
        {children.length > 0 ? (
          <div className="card-grid">
            {children.map((c) => <NoteCard key={c.id} note={c} status={c.status_id ? status.get(c.status_id) : undefined} childCount={(kids.get(c.id) || []).length} />)}
          </div>
        ) : (
          <p className="muted small">No child notes yet.</p>
        )}
      </section>

      {(backlinks.length > 0 || outlinks.length > 0) && (
        <section className="section">
          <div className="section-head"><h2><Link2 size={17} /> Linked notes</h2></div>
          <div className="links-cols">
            {outlinks.length > 0 && (
              <div>
                <div className="meta-label">Links to</div>
                {outlinks.map((n) => <Link key={n.id} href={`/note/${n.id}`} className="link-row"><span className="tree-dot" style={{ background: n.color || 'var(--border-strong)' }} />{n.title || 'Untitled'}</Link>)}
              </div>
            )}
            {backlinks.length > 0 && (
              <div>
                <div className="meta-label">Linked from</div>
                {backlinks.map((n) => <Link key={n.id} href={`/note/${n.id}`} className="link-row"><span className="tree-dot" style={{ background: n.color || 'var(--border-strong)' }} />{n.title || 'Untitled'}</Link>)}
              </div>
            )}
          </div>
        </section>
      )}

      {moving && <MoveDialog note={note} onClose={() => setMoving(false)} />}
    </div>
  )
}

function TitleInput({ note, onSave }: { note: Note; onSave: (t: string) => void }) {
  const [value, setValue] = useState(note.title)
  const timer = useRef<number>(undefined)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setValue(note.title)
  }, [note.title])
  return (
    <input
      className="note-title-input"
      value={value}
      placeholder="Untitled"
      autoFocus={!note.title}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        clearTimeout(timer.current)
        if (value !== note.title) onSave(value)
      }}
      onChange={(e) => {
        setValue(e.target.value)
        clearTimeout(timer.current)
        const v = e.target.value
        timer.current = window.setTimeout(() => onSave(v), 400)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}

function DateFields({ note, onChange }: { note: Note; onChange: (p: Partial<Note>) => void }) {
  const [range, setRange] = useState(!!note.date_end)
  if (!note.date_start && !range) {
    return (
      <button className="chip-btn" onClick={() => onChange({ date_start: todayIso() })}>
        <CalendarPlus size={15} /> <span className="chip-label">Add date</span>
      </button>
    )
  }
  return (
    <div className="date-fields">
      <input type="date" className="select" value={note.date_start ?? ''} onChange={(e) => onChange({ date_start: e.target.value || null })} aria-label="Date" />
      {range ? (
        <>
          <span className="muted">→</span>
          <input type="date" className="select" value={note.date_end ?? ''} min={note.date_start ?? undefined}
            onChange={(e) => onChange({ date_end: e.target.value || null })} aria-label="End date" />
          <button className="icon-btn" title="Remove end date" onClick={() => { setRange(false); onChange({ date_end: null }) }}><X size={14} /></button>
        </>
      ) : (
        <button className="link-btn" onClick={() => setRange(true)}>+ end date</button>
      )}
      <button className="icon-btn" title="Clear date" onClick={() => { setRange(false); onChange({ date_start: null, date_end: null }) }}><Trash2 size={14} /></button>
    </div>
  )
}

export function NoteCard({ note, status, childCount, compact }: { note: Note; status?: import('../db').Status; childCount?: number; compact?: boolean }) {
  return (
    <Link href={`/note/${note.id}`} className={`note-card${compact ? ' compact' : ''}`} style={{ borderLeftColor: note.color || 'var(--border-strong)', background: note.color ? tint(note.color, 0.07) : undefined }}>
      <div className="note-card-title">{note.title || 'Untitled'}</div>
      {(note.date_start || status) && (
        <div className="note-card-meta">
          <DateChip start={note.date_start} end={note.date_end} />
          <StatusChip status={status} small />
        </div>
      )}
      {!compact && note.content_text && <div className="note-card-snippet">{note.content_text.slice(0, 140)}</div>}
      {!!childCount && <div className="note-card-foot"><CornerDownRight size={12} /> {childCount} child note{childCount > 1 ? 's' : ''}</div>}
    </Link>
  )
}

function Attachments({ attachments, pending, onFiles }: { attachments: import('../db').Attachment[]; pending: Set<string>; onFiles: (f: File[], inline: boolean) => Promise<string[]> }) {
  const input = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)
  const open = async (a: import('../db').Attachment, download: boolean) => {
    const url = await attachmentUrl(a.id)
    if (!url) {
      alert('This file is not available offline yet. Connect to the internet to download it.')
      return
    }
    const link = document.createElement('a')
    link.href = url
    if (download) link.download = a.filename
    else link.target = '_blank'
    link.click()
  }
  const sorted = [...attachments].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return (
    <section
      className={`section attachments${drag ? ' drag' : ''}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) onFiles(files, false)
      }}
    >
      <div className="section-head">
        <h2><Paperclip size={17} /> Attachments {attachments.length > 0 && <span className="count">{attachments.length}</span>}</h2>
        <button className="btn small" onClick={() => input.current?.click()}><Upload size={15} /> Add files</button>
        <input ref={input} type="file" multiple hidden onChange={(e) => { onFiles(Array.from(e.target.files || []), false); e.target.value = '' }} />
      </div>
      {sorted.length === 0 ? (
        <p className="muted small">Drop files here, or paste images straight into the note.</p>
      ) : (
        <ul className="att-list">
          {sorted.map((a) => (
            <li key={a.id} className="att-row">
              {a.mime.startsWith('image/') ? <FileImage size={18} /> : a.mime.includes('pdf') || a.mime.startsWith('text/') ? <FileText size={18} /> : <FileIcon size={18} />}
              <button className="att-name" onClick={() => open(a, false)} title="Open">{a.filename}</button>
              {a.inline && <span className="tag">in note</span>}
              {pending.has(a.id) && <span className="tag warn" title="Will upload when online"><CloudUpload size={12} /> waiting</span>}
              <span className="muted small">{formatSize(a.size)}</span>
              <button className="icon-btn" title="Download" onClick={() => open(a, true)}><Download size={16} /></button>
              <button
                className="icon-btn danger"
                title="Delete attachment"
                onClick={() => confirm(`Delete "${a.filename}"?${a.inline ? ' It is also shown inside the note.' : ''}`) && remove('attachments', a.id)}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function MoveDialog({ note, onClose }: { note: Note; onClose: () => void }) {
  const topics = useTopics()
  const notes = useAllNotes()
  const [topicId, setTopicId] = useState(note.topic_id ?? '')
  const [parentId, setParentId] = useState(note.parent_id ?? '')
  const [blocked, setBlocked] = useState<Set<string>>(new Set([note.id]))
  useEffect(() => {
    descendantIds(note.id).then((ids) => setBlocked(new Set([note.id, ...ids])))
  }, [note.id])
  const candidates = notes.filter((n) => n.topic_id === topicId && !blocked.has(n.id)).sort((a, b) => a.title.localeCompare(b.title))

  const save = async () => {
    await update('notes', note.id, { topic_id: topicId || null, parent_id: parentId || null })
    if (topicId !== note.topic_id) {
      for (const d of await descendantIds(note.id)) await update('notes', d, { topic_id: topicId || null })
    }
    onClose()
  }
  return (
    <Modal title="Move note" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Move</button></>}>
      <label className="field">
        <span>Topic</span>
        <select className="select" value={topicId} onChange={(e) => { setTopicId(e.target.value); setParentId('') }}>
          {topics.map((t) => <option key={t.id} value={t.id}>{t.name || 'Untitled topic'}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Parent note</span>
        <select className="select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">— none (top level of topic) —</option>
          {candidates.map((n) => <option key={n.id} value={n.id}>{n.title || 'Untitled'}</option>)}
        </select>
      </label>
    </Modal>
  )
}
