export type Theme = 'system' | 'light' | 'dark'

export function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
}

export function initTheme() {
  try {
    applyTheme((JSON.parse(localStorage.getItem('ng_theme') || '"system"') as Theme) || 'system')
  } catch {
    applyTheme('system')
  }
}
