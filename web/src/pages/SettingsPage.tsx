import { useEffect, useState } from 'react'
import { useSearchParams } from 'wouter'
import { LogOut, RefreshCw, Shield } from 'lucide-react'
import { api } from '../api'
import { logout, pendingCount, refreshUser, useAuth, type User } from '../auth'
import { useLocalState } from '../hooks'
import { syncNow, useSyncState } from '../sync'
import { timeAgo } from '../util'
import { applyTheme, type Theme } from '../theme'

export function SettingsPage() {
  const auth = useAuth()
  const sync = useSyncState()
  const [params] = useSearchParams()
  const [theme, setTheme] = useLocalState<Theme>('ng_theme', 'system')
  if (auth.status !== 'signed-in') return null
  const user = auth.user

  return (
    <div className="page narrow">
      <h1>Settings</h1>
      {params.get('error') && <div className="alert error">{params.get('error')}</div>}

      <section className="panel">
        <h2>Account</h2>
        <ProfileForm user={user} />
        <PasswordForm user={user} />
        <div className="row">
          <span>Google sign-in</span>
          <span className="spacer" />
          {user.has_google ? <span className="tag">Linked</span> : <a className="btn small" href="/api/auth/google/start?link=1">Link Google account</a>}
        </div>
      </section>

      <section className="panel">
        <h2>Appearance</h2>
        <div className="seg">
          {(['system', 'light', 'dark'] as Theme[]).map((t) => (
            <button key={t} className={theme === t ? 'active' : ''} onClick={() => { setTheme(t); applyTheme(t) }}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Sync</h2>
        <p className="muted small">
          Your notes are saved on this device first and synced to the server whenever you are online.
          {' '}Status: {sync.online ? 'online' : 'offline'} · last sync {timeAgo(sync.lastSync)}
          {sync.error && <> · <span className="danger-text">{sync.error}</span></>}
        </p>
        <button className="btn" onClick={() => syncNow()} disabled={sync.syncing}><RefreshCw size={15} className={sync.syncing ? 'spin' : ''} /> Sync now</button>
      </section>

      {user.is_admin && <AdminSettings />}

      <section className="panel">
        <button
          className="btn danger"
          onClick={async () => {
            const n = await pendingCount()
            if (n && !confirm(`${n} change(s) on this device have not been synced yet and will be lost. Sign out anyway?`)) return
            await logout()
          }}
        >
          <LogOut size={15} /> Sign out
        </button>
        <p className="muted small">Signing out removes the local copy of your notes from this device.</p>
      </section>
    </div>
  )
}

function ProfileForm({ user }: { user: User }) {
  const [name, setName] = useState(user.name)
  const [msg, setMsg] = useState('')
  return (
    <form className="form-row" onSubmit={async (e) => {
      e.preventDefault()
      try {
        refreshUser(await api<User>('/api/auth/me', { method: 'PATCH', json: { name } }))
        setMsg('Saved')
      } catch (err) {
        setMsg((err as Error).message)
      }
    }}>
      <label className="field"><span>Email</span><input className="input" value={user.email} disabled /></label>
      <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <button className="btn" type="submit">Save</button>
      {msg && <span className="muted small">{msg}</span>}
    </form>
  )
}

function PasswordForm({ user }: { user: User }) {
  const [cur, setCur] = useState('')
  const [next, setNext] = useState('')
  const [msg, setMsg] = useState('')
  return (
    <form className="form-row" onSubmit={async (e) => {
      e.preventDefault()
      try {
        await api('/api/auth/password', { method: 'POST', json: { current: cur, new: next } })
        setCur('')
        setNext('')
        setMsg('Password updated. Other devices were signed out.')
        if (!user.has_password) refreshUser({ ...user, has_password: true })
      } catch (err) {
        setMsg((err as Error).message)
      }
    }}>
      {user.has_password && (
        <label className="field"><span>Current password</span><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></label>
      )}
      <label className="field"><span>{user.has_password ? 'New password' : 'Set a password'}</span>
        <input className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
      </label>
      <button className="btn" type="submit" disabled={next.length < 8}>{user.has_password ? 'Change password' : 'Set password'}</button>
      {msg && <span className="muted small">{msg}</span>}
    </form>
  )
}

interface AdminCfg {
  allow_signup: boolean
  google_enabled: boolean
  google_client_id: string
  google_secret_set: boolean
  google_redirect: string
}

function AdminSettings() {
  const [cfg, setCfg] = useState<AdminCfg | null>(null)
  const [secret, setSecret] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => {
    api<AdminCfg>('/api/admin/settings').then(setCfg).catch((e) => setMsg(e.message))
  }, [])
  if (!cfg) return <section className="panel"><h2><Shield size={17} /> Server (admin)</h2><p className="muted small">{msg || 'Loading…'}</p></section>
  const save = async () => {
    try {
      setCfg(await api<AdminCfg>('/api/admin/settings', { method: 'PUT', json: { ...cfg, google_client_secret: secret } }))
      setSecret('')
      setMsg('Saved')
    } catch (e) {
      setMsg((e as Error).message)
    }
  }
  return (
    <section className="panel">
      <h2><Shield size={17} /> Server (admin)</h2>
      <p className="muted small">These settings apply to everyone. Environment variables only provide the initial values.</p>
      <label className="check"><input type="checkbox" checked={cfg.allow_signup} onChange={(e) => setCfg({ ...cfg, allow_signup: e.target.checked })} /> Allow new accounts to sign up</label>
      <label className="check"><input type="checkbox" checked={cfg.google_enabled} onChange={(e) => setCfg({ ...cfg, google_enabled: e.target.checked })} /> Enable Google sign-in</label>
      <label className="field"><span>Google client ID</span><input className="input" value={cfg.google_client_id} onChange={(e) => setCfg({ ...cfg, google_client_id: e.target.value })} /></label>
      <label className="field">
        <span>Google client secret {cfg.google_secret_set && <span className="tag">set</span>}</span>
        <input className="input" type="password" placeholder={cfg.google_secret_set ? 'Leave empty to keep the current secret' : ''} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" />
      </label>
      <p className="muted small">Authorised redirect URI for the Google console: <code>{cfg.google_redirect}</code></p>
      <div className="row"><button className="btn primary" onClick={save}>Save server settings</button>{msg && <span className="muted small">{msg}</span>}</div>
    </section>
  )
}
