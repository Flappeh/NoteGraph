import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import { Maximize2, Search } from 'lucide-react'
import { useAllNotes, useLocalState, useStatusMap, useTopics } from '../hooks'
import { formatRange } from '../util'

interface Filters {
  topic: string
  showTopics: boolean
  showChildren: boolean
  showLinks: boolean
  hideDone: boolean
  layout: 'force' | 'tree'
}

export default function GraphPage() {
  const notes = useAllNotes()
  const topics = useTopics()
  const { status } = useStatusMap()
  const [, navigate] = useLocation()
  const [f, setF] = useLocalState<Filters>('ng_graph_filters', {
    topic: '', showTopics: true, showChildren: true, showLinks: true, hideDone: false, layout: 'force',
  })
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const cy = useRef<Core | null>(null)
  const layoutRef = useRef<cytoscape.Layouts | null>(null)
  const structure = useRef('')
  const navRef = useRef(navigate)
  navRef.current = navigate

  const elements = useMemo(() => {
    const visible = notes.filter((n) =>
      (!f.topic || n.topic_id === f.topic) && !(f.hideDone && n.status_id && status.get(n.status_id)?.done))
    const ids = new Set(visible.map((n) => n.id))
    const els: ElementDefinition[] = []
    if (f.showTopics) {
      for (const t of topics) {
        if (f.topic && t.id !== f.topic) continue
        els.push({ group: 'nodes', data: { id: `topic:${t.id}`, label: `${t.icon ? t.icon + ' ' : ''}${t.name || 'Untitled'}`, color: t.color, kind: 'topic' } })
      }
    }
    for (const n of visible) {
      const st = n.status_id ? status.get(n.status_id) : undefined
      const lines = [n.title || 'Untitled']
      if (n.date_start) lines.push(`📅 ${formatRange(n.date_start, n.date_end)}`)
      if (st) lines.push(`● ${st.name}`)
      els.push({
        group: 'nodes',
        data: { id: n.id, label: lines.join('\n'), color: n.color || '#94a3b8', border: st?.color || n.color || '#94a3b8', kind: 'note', hasStatus: st ? 1 : 0 },
      })
      const parentVisible = n.parent_id && ids.has(n.parent_id)
      if (f.showChildren && parentVisible) {
        els.push({ group: 'edges', data: { id: `p:${n.id}`, source: n.parent_id!, target: n.id, kind: 'child' } })
      }
      if (f.showTopics && !parentVisible && n.topic_id && (!f.topic || f.topic === n.topic_id) && topics.some((t) => t.id === n.topic_id)) {
        els.push({ group: 'edges', data: { id: `t:${n.id}`, source: `topic:${n.topic_id}`, target: n.id, kind: 'topic' } })
      }
      if (f.showLinks) {
        for (const l of n.links) {
          if (ids.has(l) && l !== n.id) els.push({ group: 'edges', data: { id: `l:${n.id}:${l}`, source: n.id, target: l, kind: 'link' } })
        }
      }
    }
    return els
  }, [notes, topics, status, f])

  // Create the graph once.
  useEffect(() => {
    const css = getComputedStyle(document.documentElement)
    const fg = css.getPropertyValue('--text').trim() || '#111'
    const bg = css.getPropertyValue('--bg').trim() || '#fff'
    const muted = css.getPropertyValue('--text-muted').trim() || '#888'
    const c = cytoscape({
      container: box.current,
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.3,
      style: [
        {
          selector: 'node[kind="note"]',
          style: {
            shape: 'round-rectangle',
            label: 'data(label)',
            'text-wrap': 'wrap',
            'text-max-width': '180px',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': 12,
            'line-height': 1.35,
            color: fg,
            width: 'label',
            height: 'label',
            padding: '10px',
            'background-color': 'data(color)',
            'background-opacity': 0.16,
            'border-width': 2,
            'border-color': 'data(border)',
          },
        },
        { selector: 'node[hasStatus = 1]', style: { 'border-width': 3 } },
        {
          selector: 'node[kind="topic"]',
          style: {
            shape: 'ellipse',
            label: 'data(label)',
            'background-color': 'data(color)',
            width: 46,
            height: 46,
            'font-size': 15,
            'font-weight': 'bold',
            color: fg,
            'text-valign': 'bottom',
            'text-margin-y': 6,
            'text-outline-color': bg,
            'text-outline-width': 3,
          },
        },
        { selector: 'edge', style: { width: 1.6, 'curve-style': 'bezier', 'line-color': muted, opacity: 0.55 } },
        { selector: 'edge[kind="child"]', style: { 'target-arrow-shape': 'triangle', 'target-arrow-color': muted, 'arrow-scale': 0.8 } },
        { selector: 'edge[kind="topic"]', style: { 'line-style': 'dotted', opacity: 0.4 } },
        { selector: 'edge[kind="link"]', style: { 'line-style': 'dashed', 'line-color': '#8b5cf6', 'target-arrow-shape': 'vee', 'target-arrow-color': '#8b5cf6', opacity: 0.85 } },
        { selector: '.faded', style: { opacity: 0.12 } },
        { selector: 'node:selected', style: { 'border-color': '#f59e0b', 'border-width': 4 } },
      ],
    })
    c.on('tap', 'node[kind="note"]', (e) => navRef.current(`/note/${e.target.id()}`))
    c.on('tap', 'node[kind="topic"]', (e) => navRef.current(`/topic/${e.target.id().slice(6)}`))
    c.on('mouseover', 'node', (e) => {
      const hood = e.target.closedNeighborhood()
      c.elements().not(hood).addClass('faded')
    })
    c.on('mouseout', 'node', () => c.elements().removeClass('faded'))
    cy.current = c
    return () => {
      layoutRef.current?.stop()
      layoutRef.current = null
      cy.current = null
      structure.current = '' // a re-created graph needs a fresh layout
      c.destroy()
    }
  }, [])

  // Diff elements in; only re-run the layout when the structure changed.
  useEffect(() => {
    const c = cy.current
    if (!c) return
    const key = elements.map((e) => e.data.id).sort().join('|') + f.layout
    c.batch(() => {
      const want = new Set(elements.map((e) => e.data.id!))
      c.elements().forEach((el) => {
        if (!want.has(el.id())) el.remove()
      })
      // Nodes before edges: an edge needs both endpoints to exist.
      for (const group of ['nodes', 'edges']) {
        for (const e of elements) {
          if (e.group !== group) continue
          const existing = c.getElementById(e.data.id!)
          if (existing.nonempty()) existing.data(e.data)
          else c.add(e)
        }
      }
    })
    if (key !== structure.current) {
      structure.current = key
      const layout =
        f.layout === 'tree'
          ? c.layout({ name: 'breadthfirst', directed: true, spacingFactor: 1.1, animate: false, roots: c.nodes('[kind="topic"]').length ? c.nodes('[kind="topic"]').map((n) => n.id()) : undefined })
          : c.layout({ name: 'cose', animate: false, nodeRepulsion: () => 9000, idealEdgeLength: () => 90, padding: 30, randomize: true })
      layoutRef.current?.stop()
      layoutRef.current = layout
      layout.run()
    }
  }, [elements, f.layout])

  const focus = (q: string) => {
    const c = cy.current
    if (!c || !q.trim()) return
    const hit = c.nodes().filter((n) => String(n.data('label')).toLowerCase().includes(q.toLowerCase()))
    if (hit.nonempty()) {
      c.elements().unselect()
      hit.select()
      c.animate({ fit: { eles: hit, padding: 120 } }, { duration: 300 })
    }
  }

  return (
    <div className="graph-page">
      <div className="graph-controls">
        <select className="select" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} aria-label="Topic">
          <option value="">All topics</option>
          {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select className="select" value={f.layout} onChange={(e) => setF({ ...f, layout: e.target.value as Filters['layout'] })} aria-label="Layout">
          <option value="force">Force layout</option>
          <option value="tree">Tree layout</option>
        </select>
        <label className="check"><input type="checkbox" checked={f.showTopics} onChange={(e) => setF({ ...f, showTopics: e.target.checked })} /> Topics</label>
        <label className="check"><input type="checkbox" checked={f.showChildren} onChange={(e) => setF({ ...f, showChildren: e.target.checked })} /> Parent → child</label>
        <label className="check"><input type="checkbox" checked={f.showLinks} onChange={(e) => setF({ ...f, showLinks: e.target.checked })} /> <span className="legend-link" /> Links</label>
        <label className="check"><input type="checkbox" checked={f.hideDone} onChange={(e) => setF({ ...f, hideDone: e.target.checked })} /> Hide done</label>
        <div className="search small">
          <Search size={14} />
          <input placeholder="Find…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && focus(query)} />
        </div>
        <button className="icon-btn" title="Fit to screen" onClick={() => cy.current?.animate({ fit: { eles: cy.current.elements(), padding: 30 } }, { duration: 300 })}>
          <Maximize2 size={17} />
        </button>
      </div>
      <div ref={box} className="graph-canvas" />
      {elements.length === 0 && <div className="graph-empty muted">Nothing to show yet — create some notes.</div>}
    </div>
  )
}
