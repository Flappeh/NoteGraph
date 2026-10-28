import { useMemo } from 'react'
import { Link, useLocation } from 'wouter'
import { AlarmClock, CalendarDays, Clock, FolderPlus, Sparkles } from 'lucide-react'
import { createTopic } from '../actions'
import { currentUser } from '../auth'
import { useAllNotes, useStatusMap, useTopics } from '../hooks'
import { DateChip, EmptyState, StatusChip } from '../components/ui'
import { todayIso } from '../util'
import type { Note } from '../db'

export function HomePage() {
  const topics = useTopics()
  const notes = useAllNotes()
  const { status } = useStatusMap()
  const [, navigate] = useLocation()
  const today = todayIso()

  const { upcoming, overdue, recent } = useMemo(() => {
    const isDone = (n: Note) => !!(n.status_id && status.get(n.status_id)?.done)
    return {
      upcoming: notes.filter((n) => n.date_start && (n.date_end ?? n.date_start) >= today).sort((a, b) => a.date_start!.localeCompare(b.date_start!)).slice(0, 8),
      overdue: notes.filter((n) => n.date_start && (n.date_end ?? n.date_start) < today && n.status_id && !isDone(n)).sort((a, b) => b.date_start!.localeCompare(a.date_start!)).slice(0, 8),
      recent: [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 8),
    }
  }, [notes, status, today])

  const newTopic = async () => {
    const t = await createTopic()
    navigate(`/topic/${t.id}?rename=1`)
  }
  const topicOf = new Map(topics.map((t) => [t.id, t]))
  const row = (n: Note) => {
    const t = n.topic_id ? topicOf.get(n.topic_id) : undefined
    return (
      <Link key={n.id} href={`/note/${n.id}`} className="list-row">
        <span className="tree-dot" style={{ background: n.color || 'var(--border-strong)' }} />
        <span className="list-title">{n.title || 'Untitled'}</span>
        {t && <span className="muted small">{t.name}</span>}
        <span className="spacer" />
        <DateChip start={n.date_start} end={n.date_end} />
        <StatusChip status={n.status_id ? status.get(n.status_id) : undefined} small />
      </Link>
    )
  }

  if (topics.length === 0) {
    return (
      <div className="page">
        <EmptyState icon={<Sparkles size={32} />} title={`Welcome${currentUser()?.name ? `, ${currentUser()!.name}` : ''}!`}>
          <p className="muted">Start with a topic like <b>Car</b>, <b>Work</b> or <b>Holiday</b>, then add notes inside it.</p>
          <button className="btn primary" onClick={newTopic}><FolderPlus size={16} /> Create your first topic</button>
        </EmptyState>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Home</h1>
        <button className="btn primary" onClick={newTopic}><FolderPlus size={16} /> New topic</button>
      </div>

      <div className="topic-grid">
        {topics.map((t) => {
          const tn = notes.filter((n) => n.topic_id === t.id)
          const ws = tn.filter((n) => n.status_id)
          const done = ws.filter((n) => status.get(n.status_id!)?.done).length
          return (
            <Link key={t.id} href={`/topic/${t.id}`} className="topic-card" style={{ borderTopColor: t.color }}>
              <span className="topic-icon" style={{ background: t.color }}>{t.icon || t.name.slice(0, 1).toUpperCase()}</span>
              <div className="topic-card-name">{t.name || 'Untitled topic'}</div>
              <div className="muted small">{tn.length} note{tn.length === 1 ? '' : 's'}</div>
              {ws.length > 0 && (
                <div className="progress" title={`${done}/${ws.length} done`}><span style={{ width: `${(done / ws.length) * 100}%`, background: t.color }} /></div>
              )}
            </Link>
          )
        })}
      </div>

      <div className="home-cols">
        {overdue.length > 0 && (
          <section className="panel">
            <h2><AlarmClock size={17} /> Past due</h2>
            {overdue.map(row)}
          </section>
        )}
        <section className="panel">
          <h2><CalendarDays size={17} /> Upcoming</h2>
          {upcoming.length ? upcoming.map(row) : <p className="muted small">No upcoming dates.</p>}
        </section>
        <section className="panel">
          <h2><Clock size={17} /> Recently edited</h2>
          {recent.length ? recent.map(row) : <p className="muted small">Nothing yet.</p>}
        </section>
      </div>
    </div>
  )
}
