// Inline [[note link]] node. Stores the target note id; the visible label is
// looked up live so renaming a note updates every link to it.
import { mergeAttributes, Node, type Editor, type Range } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion, { type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion'

export interface LinkTarget {
  id: string
  title: string
  create?: boolean // "create a new note with this title"
}

/** Titles of all notes, kept current by the app so link labels stay fresh. */
export const noteTitles = {
  map: new Map<string, string>(),
  listeners: new Set<() => void>(),
  set(m: Map<string, string>) {
    this.map = m
    this.listeners.forEach((f) => f())
  },
}

export interface NoteLinkOptions {
  search: (query: string) => LinkTarget[]
  createNote: (title: string) => Promise<string>
  open: (id: string) => void
}

export const NoteLink = Node.create<NoteLinkOptions>({
  name: 'noteLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addOptions() {
    return { search: () => [], createNote: async () => '', open: () => {} }
  },

  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-note-link') },
      label: { default: '', parseHTML: (el) => el.textContent },
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-note-link]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { 'data-note-link': node.attrs.id, class: 'note-link', href: `/note/${node.attrs.id}` }), node.attrs.label]
  },

  renderText({ node }) {
    return `[[${noteTitles.map.get(node.attrs.id) ?? node.attrs.label}]]`
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('a')
      dom.className = 'note-link'
      dom.href = `/note/${node.attrs.id}`
      dom.dataset.noteLink = node.attrs.id
      const paint = () => {
        const title = noteTitles.map.get(node.attrs.id)
        dom.textContent = title ?? node.attrs.label ?? 'Untitled'
        dom.classList.toggle('missing', title === undefined)
      }
      paint()
      noteTitles.listeners.add(paint)
      return { dom, destroy: () => noteTitles.listeners.delete(paint) }
    }
  },

  addProseMirrorPlugins() {
    const opts = this.options
    const editor = this.editor
    return [
      Suggestion<LinkTarget>({
        editor,
        pluginKey: new PluginKey('noteLinkSuggest'),
        char: '[[',
        allowSpaces: true,
        allowedPrefixes: null,
        items: ({ query }) => {
          const q = query.replace(/\]+$/, '')
          const found = opts.search(q).slice(0, 8)
          if (q.trim() && !found.some((f) => f.title.toLowerCase() === q.trim().toLowerCase()))
            found.push({ id: '', title: q.trim(), create: true })
          return found
        },
        command: ({ editor, range, props }) => insertLink(editor, range, props, opts),
        render: suggestionPopup,
      }),
    ]
  },
})

async function insertLink(editor: Editor, range: Range, item: LinkTarget, opts: NoteLinkOptions) {
  let id = item.id
  if (item.create) id = await opts.createNote(item.title)
  // Swallow an auto-typed closing "]]" right after the range.
  const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size), '')
  const to = after.startsWith(']]') ? range.to + 2 : range.to
  editor
    .chain()
    .focus()
    .insertContentAt({ from: range.from, to }, [
      { type: 'noteLink', attrs: { id, label: item.title } },
      { type: 'text', text: ' ' },
    ])
    .run()
}

/** Minimal dropdown, positioned at the caret, without extra dependencies. */
function suggestionPopup() {
  let el: HTMLDivElement
  let items: LinkTarget[] = []
  let selected = 0
  let command: (i: LinkTarget) => void

  const draw = () => {
    el.innerHTML = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'suggest-empty'
      empty.textContent = 'Type a note title…'
      el.append(empty)
    }
    items.forEach((it, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'suggest-item' + (i === selected ? ' active' : '')
      b.textContent = it.create ? `+ Create note “${it.title}”` : it.title || 'Untitled'
      b.onmousedown = (e) => {
        e.preventDefault()
        command(it)
      }
      el.append(b)
    })
  }
  const place = (props: SuggestionProps<LinkTarget>) => {
    const r = props.clientRect?.()
    if (!r) return
    const top = Math.min(r.bottom + 6, window.innerHeight - el.offsetHeight - 8)
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8))}px`
    el.style.top = `${top}px`
  }

  return {
    onStart(props: SuggestionProps<LinkTarget>) {
      el = document.createElement('div')
      el.className = 'suggest-popup'
      document.body.append(el)
      items = props.items
      selected = 0
      command = props.command
      draw()
      place(props)
    },
    onUpdate(props: SuggestionProps<LinkTarget>) {
      items = props.items
      selected = Math.min(selected, Math.max(0, items.length - 1))
      command = props.command
      draw()
      place(props)
    },
    onKeyDown({ event }: SuggestionKeyDownProps) {
      if (event.key === 'ArrowDown') selected = (selected + 1) % Math.max(1, items.length)
      else if (event.key === 'ArrowUp') selected = (selected - 1 + items.length) % Math.max(1, items.length)
      else if (event.key === 'Enter' || event.key === 'Tab') {
        if (items[selected]) command(items[selected])
        return true
      } else return false
      draw()
      return true
    },
    onExit() {
      el?.remove()
    },
  }
}

/** Ids of all notes linked from a TipTap document. */
export function collectLinks(doc: unknown): string[] {
  const out = new Set<string>()
  const walk = (n: { type?: string; attrs?: { id?: string }; content?: unknown[] }) => {
    if (n.type === 'noteLink' && n.attrs?.id) out.add(n.attrs.id)
    n.content?.forEach((c) => walk(c as typeof n))
  }
  if (doc) walk(doc as never)
  return [...out]
}
