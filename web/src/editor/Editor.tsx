import { useEffect, useRef, useState } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor as TEditor } from '@tiptap/react'
import { getText, getTextSerializersFromSchema, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyle, Color, FontFamily, FontSize, BackgroundColor } from '@tiptap/extension-text-style'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import Highlight from '@tiptap/extension-highlight'
import TextAlign from '@tiptap/extension-text-align'
import Placeholder from '@tiptap/extension-placeholder'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Code, Code2, Highlighter, ImagePlus, Italic, Link2,
  List, ListChecks, ListOrdered, Minus, Paperclip, Quote, Redo2, RemoveFormatting, Strikethrough, Subscript as SubIcon,
  Superscript as SupIcon, Table as TableIcon, Underline, Undo2, Baseline, Indent, Outdent, FileText,
} from 'lucide-react'
import { AttachmentImage } from './attachmentImage'
import { collectLinks, NoteLink, type NoteLinkOptions } from './noteLink'

export interface EditorProps {
  noteId: string
  content: JSONContent | null
  editable: boolean
  onChange: (content: JSONContent, text: string, links: string[]) => void
  /** Store files as attachments; returns their ids (images are then inserted inline). */
  onFiles: (files: File[], inline: boolean) => Promise<string[]>
  links: NoteLinkOptions
}

const FONTS = [
  ['', 'Default font'],
  ['Inter, system-ui, sans-serif', 'Sans'],
  ['Georgia, "Times New Roman", serif', 'Serif'],
  ['ui-monospace, Consolas, monospace', 'Mono'],
  ['"Comic Sans MS", "Segoe Print", cursive', 'Handwriting'],
] as const
const SIZES = ['', '12px', '14px', '16px', '18px', '20px', '24px', '30px', '36px', '48px']

export function NoteEditor(props: EditorProps) {
  const { noteId, content, editable, onChange, onFiles, links } = props
  const lastSaved = useRef<string>(JSON.stringify(content))
  const saveTimer = useRef<number>(undefined)
  const pending = useRef<(() => void) | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onFilesRef = useRef(onFiles)
  onFilesRef.current = onFiles

  const editor = useEditor(
    {
      editable,
      content: content ?? '',
      immediatelyRender: true,
      shouldRerenderOnTransaction: false,
      extensions: [
        StarterKit.configure({
          link: { openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
          heading: { levels: [1, 2, 3, 4] },
        }),
        TextStyle,
        Color,
        BackgroundColor,
        FontFamily,
        FontSize,
        Highlight.configure({ multicolor: true }),
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Subscript,
        Superscript,
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        AttachmentImage,
        NoteLink.configure(links),
        Placeholder.configure({ placeholder: 'Write something… type [[ to link another note' }),
      ],
      editorProps: {
        handlePaste: (_view, event) => {
          const files = Array.from(event.clipboardData?.files || [])
          if (!files.length) return false
          event.preventDefault()
          insertFiles(files)
          return true
        },
        handleDrop: (view, event) => {
          const files = Array.from((event as DragEvent).dataTransfer?.files || [])
          if (!files.length) return false
          event.preventDefault()
          const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
          insertFiles(files, pos)
          return true
        },
        handleClick: (view, _pos, event) => {
          const a = (event.target as HTMLElement).closest('a')
          if (!a) return false
          const noteLink = a.getAttribute('data-note-link')
          if (noteLink && (!view.editable || event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            links.open(noteLink)
            return true
          }
          if (!noteLink && a.href && (!view.editable || event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            window.open(a.href, '_blank', 'noopener')
            return true
          }
          if (noteLink) event.preventDefault()
          return false
        },
      },
      onUpdate: ({ editor }) => {
        // Only user edits are saved; view mode and normalisation on load are not.
        if (!editor.isEditable) return
        clearTimeout(saveTimer.current)
        // Snapshot the (immutable) document now: the save may run after the
        // editor is destroyed, e.g. when navigating away mid-typing.
        const doc = editor.state.doc
        const serializers = getTextSerializersFromSchema(editor.schema)
        const save = () => {
          clearTimeout(saveTimer.current)
          pending.current = null
          const json = doc.toJSON() as JSONContent
          lastSaved.current = JSON.stringify(json)
          onChangeRef.current(json, getText(doc, { blockSeparator: '\n', textSerializers: serializers }), collectLinks(json))
        }
        pending.current = save
        saveTimer.current = window.setTimeout(save, 500)
      },
      onBlur: () => pending.current?.(),
    },
    [noteId],
  )

  async function insertFiles(files: File[], pos?: number, attachOnly = false) {
    if (attachOnly) {
      await onFilesRef.current(files, false)
      return
    }
    const images = files.filter((f) => f.type.startsWith('image/'))
    const others = files.filter((f) => !f.type.startsWith('image/'))
    if (others.length) await onFilesRef.current(others, false)
    if (!images.length || !editor) return
    const ids = await onFilesRef.current(images, true)
    // Trailing paragraph moves the cursor past the images, so typing next
    // doesn't replace a selected image.
    const nodes = [...ids.map((id) => ({ type: 'image', attrs: { attachmentId: id } })), { type: 'paragraph' }]
    if (pos !== undefined) editor.chain().focus().insertContentAt(pos, nodes).run()
    else editor.chain().focus().insertContent(nodes).run()
  }

  // Flush pending edits when leaving the note.
  useEffect(() => () => pending.current?.(), [noteId])

  useEffect(() => {
    if (!editor) return
    editor.setEditable(editable)
    if (!editable) pending.current?.()
  }, [editor, editable])

  // Apply remote changes (from sync) unless they are our own echo.
  useEffect(() => {
    if (!editor) return
    const incoming = JSON.stringify(content)
    if (incoming === lastSaved.current || pending.current) return
    lastSaved.current = incoming
    editor.commands.setContent(content ?? '', { emitUpdate: false })
  }, [editor, content])

  if (!editor) return null
  return (
    <div className={`editor ${editable ? 'editing' : 'viewing'}`}>
      {editable && <Toolbar editor={editor} onPickFiles={(f, attachOnly) => insertFiles(f, undefined, attachOnly)} />}
      <EditorContent editor={editor} className="prose" />
    </div>
  )
}

function Btn({ on, active, title, children, disabled }: { on: () => void; active?: boolean; title: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`tb-btn${active ? ' active' : ''}`}
      title={title}
      aria-label={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={on}
    >
      {children}
    </button>
  )
}

function Toolbar({ editor, onPickFiles }: { editor: TEditor; onPickFiles: (f: File[], attachOnly?: boolean) => void }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      block: e.isActive('heading', { level: 1 }) ? 'h1'
        : e.isActive('heading', { level: 2 }) ? 'h2'
        : e.isActive('heading', { level: 3 }) ? 'h3'
        : e.isActive('heading', { level: 4 }) ? 'h4'
        : e.isActive('codeBlock') ? 'code' : 'p',
      font: (e.getAttributes('textStyle').fontFamily as string) || '',
      size: (e.getAttributes('textStyle').fontSize as string) || '',
      color: (e.getAttributes('textStyle').color as string) || '',
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      highlight: e.isActive('highlight'),
      align: (['left', 'center', 'right', 'justify'] as const).find((a) => e.isActive({ textAlign: a })) || 'left',
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      link: e.isActive('link'),
      table: e.isActive('table'),
      image: e.isActive('image'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      listItem: e.isActive('listItem') || e.isActive('taskItem'),
    }),
  })
  const fileInput = useRef<HTMLInputElement>(null)
  const imageInput = useRef<HTMLInputElement>(null)
  const [hl, setHl] = useState('#fde68a')
  const c = () => editor.chain().focus()

  const setBlock = (v: string) => {
    if (v === 'p') c().setParagraph().run()
    else if (v === 'code') c().toggleCodeBlock().run()
    else c().setHeading({ level: Number(v[1]) as 1 | 2 | 3 | 4 }).run()
  }
  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    const url = window.prompt('Link URL (leave empty to remove)', prev || 'https://')
    if (url === null) return
    if (!url || url === 'https://') c().extendMarkRange('link').unsetLink().run()
    else c().extendMarkRange('link').setLink({ href: url }).run()
  }
  const item = editor.isActive('taskItem') ? 'taskItem' : 'listItem'

  return (
    <div className="toolbar" role="toolbar">
      <div className="tb-group">
        <Btn title="Undo" on={() => c().undo().run()} disabled={!s.canUndo}><Undo2 size={16} /></Btn>
        <Btn title="Redo" on={() => c().redo().run()} disabled={!s.canRedo}><Redo2 size={16} /></Btn>
      </div>
      <div className="tb-group">
        <select className="tb-select" value={s.block} onChange={(e) => setBlock(e.target.value)} title="Text type">
          <option value="p">Paragraph</option>
          <option value="h1">Heading 1</option>
          <option value="h2">Heading 2</option>
          <option value="h3">Heading 3</option>
          <option value="h4">Heading 4</option>
          <option value="code">Code block</option>
        </select>
        <select
          className="tb-select"
          value={s.font}
          title="Font"
          onChange={(e) => (e.target.value ? c().setFontFamily(e.target.value).run() : c().unsetFontFamily().run())}
        >
          {FONTS.map(([v, l]) => <option key={l} value={v}>{l}</option>)}
        </select>
        <select
          className="tb-select narrow"
          value={s.size}
          title="Font size"
          onChange={(e) => (e.target.value ? c().setFontSize(e.target.value).run() : c().unsetFontSize().run())}
        >
          {SIZES.map((v) => <option key={v} value={v}>{v ? v.replace('px', '') : 'Size'}</option>)}
        </select>
      </div>
      <div className="tb-group">
        <Btn title="Bold (Ctrl+B)" active={s.bold} on={() => c().toggleBold().run()}><Bold size={16} /></Btn>
        <Btn title="Italic (Ctrl+I)" active={s.italic} on={() => c().toggleItalic().run()}><Italic size={16} /></Btn>
        <Btn title="Underline (Ctrl+U)" active={s.underline} on={() => c().toggleUnderline().run()}><Underline size={16} /></Btn>
        <Btn title="Strikethrough" active={s.strike} on={() => c().toggleStrike().run()}><Strikethrough size={16} /></Btn>
        <Btn title="Inline code" active={s.code} on={() => c().toggleCode().run()}><Code size={16} /></Btn>
        <Btn title="Subscript" active={s.sub} on={() => c().toggleSubscript().run()}><SubIcon size={16} /></Btn>
        <Btn title="Superscript" active={s.sup} on={() => c().toggleSuperscript().run()}><SupIcon size={16} /></Btn>
      </div>
      <div className="tb-group">
        <label className="tb-btn color" title="Text colour" onMouseDown={(e) => e.preventDefault()}>
          <Baseline size={16} style={{ color: s.color || undefined }} />
          <input type="color" value={s.color || '#000000'} onChange={(e) => c().setColor(e.target.value).run()} />
        </label>
        <label className="tb-btn color" title="Highlight colour">
          <Highlighter size={16} style={{ color: hl }} />
          <input type="color" value={hl} onChange={(e) => { setHl(e.target.value); c().setHighlight({ color: e.target.value }).run() }} />
        </label>
        <Btn title="Toggle highlight" active={s.highlight} on={() => c().toggleHighlight({ color: hl }).run()}>
          <span className="hl-swatch" style={{ background: hl }} />
        </Btn>
        <Btn title="Clear formatting" on={() => c().unsetAllMarks().clearNodes().run()}><RemoveFormatting size={16} /></Btn>
      </div>
      <div className="tb-group">
        <Btn title="Align left" active={s.align === 'left'} on={() => c().setTextAlign('left').run()}><AlignLeft size={16} /></Btn>
        <Btn title="Align centre" active={s.align === 'center'} on={() => c().setTextAlign('center').run()}><AlignCenter size={16} /></Btn>
        <Btn title="Align right" active={s.align === 'right'} on={() => c().setTextAlign('right').run()}><AlignRight size={16} /></Btn>
        <Btn title="Justify" active={s.align === 'justify'} on={() => c().setTextAlign('justify').run()}><AlignJustify size={16} /></Btn>
      </div>
      <div className="tb-group">
        <Btn title="Bullet list" active={s.bullet} on={() => c().toggleBulletList().run()}><List size={16} /></Btn>
        <Btn title="Numbered list" active={s.ordered} on={() => c().toggleOrderedList().run()}><ListOrdered size={16} /></Btn>
        <Btn title="Checklist" active={s.task} on={() => c().toggleTaskList().run()}><ListChecks size={16} /></Btn>
        <Btn title="Indent" disabled={!s.listItem} on={() => c().sinkListItem(item).run()}><Indent size={16} /></Btn>
        <Btn title="Outdent" disabled={!s.listItem} on={() => c().liftListItem(item).run()}><Outdent size={16} /></Btn>
        <Btn title="Quote" active={s.quote} on={() => c().toggleBlockquote().run()}><Quote size={16} /></Btn>
        <Btn title="Code block" active={s.block === 'code'} on={() => c().toggleCodeBlock().run()}><Code2 size={16} /></Btn>
        <Btn title="Divider" on={() => c().setHorizontalRule().run()}><Minus size={16} /></Btn>
      </div>
      <div className="tb-group">
        <Btn title="Web link" active={s.link} on={setLink}><Link2 size={16} /></Btn>
        <Btn title="Link to a note ([[)" on={() => c().insertContent('[[').run()}><FileText size={16} /></Btn>
        <Btn title="Insert image" on={() => imageInput.current?.click()}><ImagePlus size={16} /></Btn>
        <Btn title="Attach file" on={() => fileInput.current?.click()}><Paperclip size={16} /></Btn>
        <Btn title="Insert table" on={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><TableIcon size={16} /></Btn>
        <input ref={imageInput} type="file" accept="image/*" multiple hidden
          onChange={(e) => { onPickFiles(Array.from(e.target.files || [])); e.target.value = '' }} />
        <input ref={fileInput} type="file" multiple hidden
          onChange={(e) => { onPickFiles(Array.from(e.target.files || []), true); e.target.value = '' }} />
      </div>
      {s.table && (
        <div className="tb-group contextual">
          <span className="tb-label">Table</span>
          <Btn title="Add row below" on={() => c().addRowAfter().run()}>+Row</Btn>
          <Btn title="Add column right" on={() => c().addColumnAfter().run()}>+Col</Btn>
          <Btn title="Delete row" on={() => c().deleteRow().run()}>−Row</Btn>
          <Btn title="Delete column" on={() => c().deleteColumn().run()}>−Col</Btn>
          <Btn title="Toggle header row" on={() => c().toggleHeaderRow().run()}>Header</Btn>
          <Btn title="Delete table" on={() => c().deleteTable().run()}>Delete</Btn>
        </div>
      )}
      {s.image && (
        <div className="tb-group contextual">
          <span className="tb-label">Image</span>
          {['25%', '50%', '75%', '100%'].map((w) => (
            <Btn key={w} title={`Width ${w}`} on={() => c().updateAttributes('image', { width: w }).run()}>{w}</Btn>
          ))}
          <Btn title="Original size" on={() => c().updateAttributes('image', { width: null }).run()}>Auto</Btn>
        </div>
      )}
    </div>
  )
}
