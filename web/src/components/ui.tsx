import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import type { Status, StatusCategory } from '../db'
import { formatRange, PALETTE, tint } from '../util'

/** Click-to-open popover that closes on outside click or Escape. */
export function Popover({ trigger, children, align = 'left' }: { trigger: (open: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div className="popover-anchor" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && <div className={`popover ${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

export function ColorPicker({ value, onChange, allowNone = true, label = 'Colour' }: { value: string; onChange: (c: string) => void; allowNone?: boolean; label?: string }) {
  return (
    <Popover
      trigger={(toggle) => (
        <button type="button" className="chip-btn" onClick={toggle} title="Choose colour" aria-label="Choose colour">
          <span className="swatch" style={{ background: value || 'transparent' }} data-empty={!value || undefined} />
          <span className="chip-label">{label}</span>
        </button>
      )}
    >
      {(close) => (
        <div className="palette">
          {allowNone && (
            <button type="button" className="swatch big" data-empty title="No colour" onClick={() => { onChange(''); close() }}>
              {!value && <Check size={14} />}
            </button>
          )}
          {PALETTE.map((c) => (
            <button key={c} type="button" className="swatch big" style={{ background: c }} title={c} onClick={() => { onChange(c); close() }}>
              {value === c && <Check size={14} color="#fff" />}
            </button>
          ))}
          <label className="swatch big custom" title="Custom colour">
            <input type="color" value={value || '#6366f1'} onChange={(e) => onChange(e.target.value)} />
          </label>
        </div>
      )}
    </Popover>
  )
}

export function StatusChip({ status, small }: { status?: Status | null; small?: boolean }) {
  if (!status) return null
  return (
    <span className={`status-chip${small ? ' small' : ''}`} style={{ background: tint(status.color, 0.18), color: status.color, borderColor: tint(status.color, 0.45) }}>
      <span className="dot" style={{ background: status.color }} />
      {status.name || 'Unnamed'}
    </span>
  )
}

export function DateChip({ start, end }: { start: string | null; end: string | null }) {
  if (!start) return null
  return <span className="date-chip">📅 {formatRange(start, end)}</span>
}

/** Two-step picker: choose a status category, then a status inside it. */
export function StatusPicker({
  categories,
  statuses,
  categoryId,
  statusId,
  onChange,
}: {
  categories: StatusCategory[]
  statuses: Status[]
  categoryId: string | null
  statusId: string | null
  onChange: (categoryId: string | null, statusId: string | null) => void
}) {
  const current = statuses.find((s) => s.id === statusId)
  const cat = categoryId ?? current?.category_id ?? null
  const inCat = statuses.filter((s) => s.category_id === cat)
  return (
    <div className="status-picker">
      <select
        className="select"
        value={cat ?? ''}
        onChange={(e) => onChange(e.target.value || null, null)}
        aria-label="Status category"
        title="Status category"
      >
        <option value="">No status</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>{c.name || 'Unnamed category'}</option>
        ))}
      </select>
      {cat && (
        <select
          className="select"
          value={statusId ?? ''}
          onChange={(e) => onChange(cat, e.target.value || null)}
          aria-label="Status"
          title="Status"
          style={current ? { borderColor: current.color, color: current.color } : undefined}
        >
          <option value="">— pick status —</option>
          {inCat.map((s) => (
            <option key={s.id} value={s.id}>{s.name || 'Unnamed'}</option>
          ))}
        </select>
      )}
    </div>
  )
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children}
    </div>
  )
}
