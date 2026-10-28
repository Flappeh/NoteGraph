import { useMemo, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  AlertTriangle, ChevronRight, CloudOff, Home, ListTodo, Network, Plus, RefreshCw, Search, Settings, Check,
} from 'lucide-react'
import { childIndex, createNote, createTopic } from '../actions'
import { db, type Note } from '../db'
import { useAllNotes, useLocalState, useStatusMap, useTopics } from '../hooks'
import { syncNow, useSyncState } from '../sync'
import { timeAgo } from '../util'

export function Sidebar({ onNavigate }: { onNavigate: () => void }) {
  const topics = useTopics()
  const notes = useAllNotes()
  const { status } = useStatusMap()
  const [location, navigate] = useLocation()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useLocalState<Record<string, boolean>>('ng_tree_open', {})
  const kids = useMemo(() => childIndex(notes), [notes])
  const conflicts = useLiveQuery(() => db.conflicts.count(), []) ?? 0

  const go = (path: string) => {
    navigate(path)
    onNavigate()
  }
  const toggle = (id: string) => setOpen({ ...open, [id]: !open[id] })

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return notes
      .filter((n) => n.title.toLowerCase().includes(q) || n.content_text.toLowerCase().includes(q))
      .slice(0, 30)
  }, [query, notes])

  const newNote = async (topicId: string, parentId: string | null) => {
    const n = await createNote(topicId, parentId)
    setOpen({ ...open, [parentId ?? topicId]: true })
    go(`/note/${n.id}?edit=1`)
  }

  const renderNotes = (key: string, depth: number) =>
    (kids.get(key) || []).map((n: Note) => {
      const children = kids.get(n.id) || []
      const st = n.status_id ? status.get(n.status_id) : undefined
      const active = location === `/note/${n.id}`
      return (
        <div key={n.id}>
          <div className={`tree-row${active ? ' active' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
            <button className={`twisty${children.length ? '' : ' hidden'}${open[n.id] ? ' open' : ''}`} onClick={() => toggle(n.id)} aria-label="Expand">
              <ChevronRight size={14} />
            </button>
            <span className="tree-dot" style={{ background: n.color || 'var(--border-strong)' }} />
            <button className="tree-label" onClick={() => go(`/note/${n.id}`)} title={n.title}>
              {n.title || 'Untitled'}
            </button>
            {st && <span className="tree-status" style={{ background: st.color }} title={st.name} />}
            <button className="tree-add" title="Add child note" onClick={() => newNote(n.topic_id!, n.id)}>
              <Plus size={14} />
            </button>
          </div>
          {open[n.id] && renderNotes(n.id, depth + 1)}
        </div>
      )
    })

  return (
    <nav className="sidebar">
      <div className="brand">
        <img src="/favicon.svg" alt="" width={26} height={26} />
        <span>NoteGraph</span>
      </div>

      <div className="search">
        <Search size={15} />
        <input placeholder="Search notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {query ? (
        <div className="search-results">
          {results.length === 0 && <div className="muted small pad">No matches</div>}
          {results.map((n) => (
            <button key={n.id} className="result" onClick={() => { setQuery(''); go(`/note/${n.id}`) }}>
              <span className="tree-dot" style={{ background: n.color || 'var(--border-strong)' }} />
              <span>{n.title || 'Untitled'}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="nav">
            <NavItem icon={<Home size={17} />} label="Home" path="/" go={go} active={location === '/'} />
            <NavItem icon={<Network size={17} />} label="Graph" path="/graph" go={go} active={location === '/graph'} />
            <NavItem icon={<ListTodo size={17} />} label="Statuses" path="/statuses" go={go} active={location === '/statuses'} />
            {conflicts > 0 && (
              <NavItem icon={<AlertTriangle size={17} />} label={`Conflicts (${conflicts})`} path="/conflicts" go={go} active={location === '/conflicts'} warn />
            )}
            <NavItem icon={<Settings size={17} />} label="Settings" path="/settings" go={go} active={location === '/settings'} />
          </div>

          <div className="tree-head">
            <span>Topics</span>
            <button
              className="icon-btn"
              title="New topic"
              onClick={async () => {
                const t = await createTopic()
                go(`/topic/${t.id}?rename=1`)
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="tree">
            {topics.length === 0 && <div className="muted small pad">No topics yet. Create one with +</div>}
            {topics.map((t) => (
              <div key={t.id}>
                <div className={`tree-row topic${location === `/topic/${t.id}` ? ' active' : ''}`}>
                  <button className={`twisty${open[t.id] ? ' open' : ''}`} onClick={() => toggle(t.id)} aria-label="Expand">
                    <ChevronRight size={14} />
                  </button>
                  <span className="topic-icon" style={{ background: t.color }}>{t.icon || t.name.slice(0, 1).toUpperCase()}</span>
                  <button className="tree-label" onClick={() => go(`/topic/${t.id}`)}>{t.name || 'Untitled topic'}</button>
                  <button className="tree-add" title="Add note" onClick={() => newNote(t.id, null)}>
                    <Plus size={14} />
                  </button>
                </div>
                {open[t.id] && renderNotes(`topic:${t.id}`, 1)}
              </div>
            ))}
          </div>
        </>
      )}
      <SyncBadge />
    </nav>
  )
}

function NavItem({ icon, label, path, go, active, warn }: { icon: React.ReactNode; label: string; path: string; go: (p: string) => void; active: boolean; warn?: boolean }) {
  return (
    <Link href={path} className={`nav-item${active ? ' active' : ''}${warn ? ' warn' : ''}`} onClick={(e) => { e.preventDefault(); go(path) }}>
      {icon}
      <span>{label}</span>
    </Link>
  )
}

function SyncBadge() {
  const s = useSyncState()
  const pending = useLiveQuery(async () => {
    const counts = await Promise.all([db.topics, db.notes, db.statuses, db.status_categories, db.attachments].map((t) => t.where('_dirty').equals(1).count()))
    return counts.reduce((a, b) => a + b, 0)
  }, []) ?? 0
  const label = !s.online
    ? `Offline${pending ? ` · ${pending} change${pending > 1 ? 's' : ''} waiting` : ''}`
    : s.syncing
      ? 'Syncing…'
      : s.error
        ? `Sync error: ${s.error}`
        : pending
          ? `${pending} change${pending > 1 ? 's' : ''} to sync`
          : `Synced ${timeAgo(s.lastSync)}`
  return (
    <button className={`sync-badge${!s.online ? ' offline' : ''}${s.error ? ' error' : ''}`} onClick={() => syncNow()} title="Sync now">
      {!s.online ? <CloudOff size={15} /> : s.syncing ? <RefreshCw size={15} className="spin" /> : s.error ? <AlertTriangle size={15} /> : pending ? <RefreshCw size={15} /> : <Check size={15} />}
      <span>{label}</span>
    </button>
  )
}
