export const PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef',
  '#ec4899', '#64748b',
]

export const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const fmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
export function formatDate(d: string | null) {
  if (!d) return ''
  const [y, m, day] = d.split('-').map(Number)
  return fmt.format(new Date(y, m - 1, day))
}

export function formatRange(a: string | null, b: string | null) {
  if (!a) return ''
  return b && b !== a ? `${formatDate(a)} → ${formatDate(b)}` : formatDate(a)
}

export function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

export function timeAgo(iso: string | null) {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** Pick black or white text for a background colour. */
export function contrastText(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 'inherit'
  const n = parseInt(m[1], 16)
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255
  return lum > 0.6 ? '#111827' : '#ffffff'
}

/** Semi-transparent version of a hex colour, for tinted backgrounds. */
export function tint(hex: string, alpha: number) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return 'transparent'
  const n = parseInt(m[1], 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
