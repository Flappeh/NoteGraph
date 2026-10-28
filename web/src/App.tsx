import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { Route, Switch, useLocation } from 'wouter'
import { Menu, WifiOff } from 'lucide-react'
import { useAuth } from './auth'
import { noteTitles } from './editor/noteLink'
import { useAllNotes } from './hooks'
import { startSync, useSyncState } from './sync'
import { Sidebar } from './components/Sidebar'
import { LoginPage } from './pages/LoginPage'
import { HomePage } from './pages/HomePage'
import { TopicPage } from './pages/TopicPage'
import { NotePage } from './pages/NotePage'
import { StatusesPage } from './pages/StatusesPage'
import { SettingsPage } from './pages/SettingsPage'
import { ConflictsPage } from './pages/ConflictsPage'

const GraphPage = lazy(() => import('./pages/GraphPage'))

export function App() {
  const auth = useAuth()
  if (auth.status === 'loading') return <div className="splash"><img src="/favicon.svg" alt="" width={48} height={48} /></div>
  if (auth.status === 'signed-out') return <LoginPage />
  return <Shell key={auth.user.id} />
}

function Shell() {
  const [drawer, setDrawer] = useState(false)
  const [location] = useLocation()
  const sync = useSyncState()
  const notes = useAllNotes()

  useEffect(() => startSync(), [])
  // Keep [[link]] labels in editors in step with note titles.
  useEffect(() => noteTitles.set(new Map(notes.map((n) => [n.id, n.title || 'Untitled']))), [notes])
  useEffect(() => setDrawer(false), [location])

  return (
    <div className={`shell${drawer ? ' drawer-open' : ''}`}>
      <header className="topbar">
        <button className="icon-btn" onClick={() => setDrawer(!drawer)} aria-label="Menu"><Menu size={22} /></button>
        <span className="topbar-title">NoteGraph</span>
        {!sync.online && <WifiOff size={18} className="muted" />}
      </header>
      <Sidebar onNavigate={() => setDrawer(false)} />
      <div className="scrim" onClick={() => setDrawer(false)} />
      <main className="main">
        <PageBoundary key={location}>
        <Suspense fallback={<div className="page muted">Loading…</div>}>
          <Switch>
            <Route path="/" component={HomePage} />
            <Route path="/topic/:id">{(p) => <TopicPage id={p.id} />}</Route>
            <Route path="/note/:id">{(p) => <NotePage id={p.id} />}</Route>
            <Route path="/graph" component={GraphPage} />
            <Route path="/statuses" component={StatusesPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/conflicts" component={ConflictsPage} />
            <Route path="/login">{() => <HomePage />}</Route>
            <Route><div className="page"><h1>Not found</h1></div></Route>
          </Switch>
        </Suspense>
        </PageBoundary>
      </main>
    </div>
  )
}

/** Keeps a crash in one page from blanking the whole app. Resets on navigation. */
class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="page">
        <h1>Something went wrong</h1>
        <p className="muted">{this.state.error.message}</p>
        <button className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    )
  }
}
