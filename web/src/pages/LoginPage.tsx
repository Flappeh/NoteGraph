import { useEffect, useState } from 'react'
import { api } from '../api'
import { afterLogin, type User } from '../auth'

interface Providers {
  google: boolean
  signup: boolean
  first_user: boolean
}

export function LoginPage() {
  const [providers, setProviders] = useState<Providers | null>(null)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState(() => new URLSearchParams(location.search).get('error') || '')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api<Providers>('/api/auth/providers')
      .then((p) => {
        setProviders(p)
        if (p.first_user) setMode('register')
      })
      .catch(() => setError('Cannot reach the server. You need to be online to sign in.'))
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const user = await api<User>(`/api/auth/${mode}`, { method: 'POST', json: { email, password, name } })
      history.replaceState(null, '', '/')
      await afterLogin(user)
    } catch (err) {
      setError(err instanceof TypeError ? 'You appear to be offline.' : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand big">
          <img src="/favicon.svg" alt="" width={40} height={40} />
          <span>NoteGraph</span>
        </div>
        <p className="muted">Notes with status, dates and a graph of how everything connects.</p>
        {providers?.first_user && <div className="alert">Create the first account. It will be the administrator.</div>}
        {error && <div className="alert error">{error}</div>}

        {providers?.google && (
          <>
            <a className="btn google" href="/api/auth/google/start">
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z"/></svg>
              Continue with Google
            </a>
            <div className="divider"><span>or</span></div>
          </>
        )}

        <form onSubmit={submit} className="login-form">
          {mode === 'register' && (
            <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          )}
          <label className="field"><span>Email</span><input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label className="field">
            <span>Password</span>
            <input className="input" type="password" required minLength={mode === 'register' ? 8 : undefined} value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
          </label>
          <button className="btn primary block" disabled={busy}>{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>

        {providers?.signup && !providers.first_user && (
          <p className="muted small center">
            {mode === 'login' ? <>No account? <button className="link-btn" onClick={() => setMode('register')}>Create one</button></>
              : <>Have an account? <button className="link-btn" onClick={() => setMode('login')}>Sign in</button></>}
          </p>
        )}
      </div>
    </div>
  )
}
