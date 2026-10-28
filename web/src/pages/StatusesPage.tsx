import { ArrowDown, ArrowUp, CheckCircle2, ListTodo, Plus, Trash2 } from 'lucide-react'
import { create, remove, update, type Status, type StatusCategory } from '../db'
import { useAllNotes, useStatusMap } from '../hooks'
import { ColorPicker, EmptyState, StatusChip } from '../components/ui'
import { PALETTE } from '../util'

/** Global status management: categories, each holding its own statuses. */
export function StatusesPage() {
  const { categories, statuses } = useStatusMap()
  const notes = useAllNotes()
  const usage = (statusId: string) => notes.filter((n) => n.status_id === statusId).length

  const addCategory = () => create('status_categories', { name: 'New category', color: PALETTE[(categories.length * 3) % PALETTE.length], sort: Date.now() })

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Statuses</h1>
          <p className="muted">
            Group statuses into categories, such as <i>Progress</i> (Not Yet → On Progress → Completed) or <i>Service</i> (Booked → Done).
            On a note you first choose a category, then a status within it.
          </p>
        </div>
        <button className="btn primary" onClick={addCategory}><Plus size={16} /> New category</button>
      </div>

      {categories.length === 0 && (
        <EmptyState icon={<ListTodo size={32} />} title="No status categories">
          <button className="btn primary" onClick={addCategory}><Plus size={16} /> Create a category</button>
        </EmptyState>
      )}

      <div className="cat-list">
        {categories.map((cat) => (
          <CategoryCard key={cat.id} cat={cat} statuses={statuses.filter((s) => s.category_id === cat.id)} usage={usage} />
        ))}
      </div>
    </div>
  )
}

function CategoryCard({ cat, statuses, usage }: { cat: StatusCategory; statuses: Status[]; usage: (id: string) => number }) {
  const addStatus = () =>
    create('statuses', { category_id: cat.id, name: 'New status', color: PALETTE[(statuses.length * 4 + 2) % PALETTE.length], sort: Date.now() })

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= statuses.length) return
    // Swap sort keys with the neighbour.
    update('statuses', statuses[i].id, { sort: statuses[j].sort })
    update('statuses', statuses[j].id, { sort: statuses[i].sort === statuses[j].sort ? statuses[i].sort + dir : statuses[i].sort })
  }

  const delCategory = () => {
    const used = statuses.reduce((a, s) => a + usage(s.id), 0)
    if (!confirm(`Delete category "${cat.name}" and its ${statuses.length} status(es)?${used ? ` ${used} note(s) will lose their status.` : ''}`)) return
    statuses.forEach((s) => remove('statuses', s.id))
    remove('status_categories', cat.id)
  }

  return (
    <section className="cat-card" style={{ borderTopColor: cat.color }}>
      <div className="cat-head">
        <input className="cat-name" defaultValue={cat.name} key={cat.name} placeholder="Category name"
          onBlur={(e) => e.target.value !== cat.name && update('status_categories', cat.id, { name: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <ColorPicker value={cat.color} onChange={(color) => update('status_categories', cat.id, { color })} allowNone={false} />
        <button className="icon-btn danger" title="Delete category" onClick={delCategory}><Trash2 size={17} /></button>
      </div>

      <div className="status-rows">
        {statuses.map((s, i) => (
          <div key={s.id} className="status-row">
            <div className="reorder">
              <button className="icon-btn" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><ArrowUp size={14} /></button>
              <button className="icon-btn" disabled={i === statuses.length - 1} onClick={() => move(i, 1)} title="Move down"><ArrowDown size={14} /></button>
            </div>
            <input className="status-name" defaultValue={s.name} key={s.name} placeholder="Status name"
              onBlur={(e) => e.target.value !== s.name && update('statuses', s.id, { name: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            <ColorPicker value={s.color} onChange={(color) => update('statuses', s.id, { color })} allowNone={false} label="" />
            <label className="done-toggle" title="Counts as finished (used for progress and past-due)">
              <input type="checkbox" checked={s.done} onChange={(e) => update('statuses', s.id, { done: e.target.checked })} />
              <CheckCircle2 size={15} /> Done
            </label>
            <StatusChip status={s} small />
            <span className="muted small usage">{usage(s.id)} note{usage(s.id) === 1 ? '' : 's'}</span>
            <button className="icon-btn danger" title="Delete status"
              onClick={() => (usage(s.id) === 0 || confirm(`"${s.name}" is used by ${usage(s.id)} note(s). Delete anyway?`)) && remove('statuses', s.id)}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        <button className="btn small ghost" onClick={addStatus}><Plus size={15} /> Add status</button>
      </div>
    </section>
  )
}
