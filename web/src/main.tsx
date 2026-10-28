import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { bootstrap } from './auth'
import { initTheme } from './theme'
import './styles.css'

initTheme()
registerSW({ immediate: true })
bootstrap()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
