// Image node whose bytes live in an attachment. The src is resolved at render
// time from the local cache (or downloaded), so images work offline.
import Image from '@tiptap/extension-image'
import { attachmentUrl } from '../db'

export const AttachmentImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      attachmentId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-attachment-id'),
        renderHTML: (a) => (a.attachmentId ? { 'data-attachment-id': a.attachmentId } : {}),
      },
      width: {
        default: null,
        parseHTML: (el) => el.style.width || null,
        renderHTML: (a) => (a.width ? { style: `width: ${a.width}` } : {}),
      },
    }
  },

  addNodeView() {
    return ({ node }) => {
      const wrap = document.createElement('span')
      wrap.className = 'img-wrap'
      const img = document.createElement('img')
      img.alt = node.attrs.alt || ''
      if (node.attrs.width) img.style.width = node.attrs.width
      wrap.append(img)
      const load = (n: typeof node) => {
        img.style.width = n.attrs.width || ''
        if (n.attrs.attachmentId) {
          wrap.classList.add('loading')
          attachmentUrl(n.attrs.attachmentId).then((url) => {
            wrap.classList.remove('loading')
            if (url) img.src = url
            else wrap.classList.add('unavailable')
          })
        } else if (n.attrs.src) img.src = n.attrs.src
      }
      load(node)
      return {
        dom: wrap,
        update: (n) => {
          if (n.type.name !== node.type.name) return false
          if (n.attrs.attachmentId !== node.attrs.attachmentId || n.attrs.src !== node.attrs.src) load(n)
          else img.style.width = n.attrs.width || ''
          node = n
          return true
        },
      }
    }
  },
}).configure({ inline: false, allowBase64: false })
