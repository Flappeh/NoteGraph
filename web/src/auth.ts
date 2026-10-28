import { useSyncExternalStore } from 'react'
import { api, ApiError } from './api'
import { deleteUserDb, db, openUserDb } from './db'

export interface User {
  id: string
  email: string
  name: string
  is_admin: boolean
  has_password: boolean
  has_google: boolean
}

type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; user: User; offline: boolean }

const CACHE_KEY = 'ng_user'
let state: AuthState = { status: 'loading' }
const listeners = new Set<() => void>()

function set(s: AuthState) {
  state = s
  listeners.forEach((f) => f())
}

export function useAuth() {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => state,
  )
}

export const currentUser = () => (state.status === 'signed-in' ? state.user : null)

function cached(): User | null {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null')
  } catch {
    return null
  }
}

export function signedIn(user: User, offline = false) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(user))
  openUserDb(user.id)
  set({ status: 'signed-in', user, offline })
}

/** Resolve the session at startup. Works offline using the cached user. */
export async function bootstrap() {
  const prev = cached()
  try {
    const me = await api<User>('/api/auth/me')
    if (prev && prev.id !== me.id) await deleteUserDb(prev.id)
    signedIn(me)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      // Session gone. Keep the local data (it may hold unsynced edits) until
      // the same user signs in again; a different user wipes it.
      set({ status: 'signed-out' })
    } else if (prev) {
      signedIn(prev, true) // offline or server unreachable: carry on locally
    } else {
      set({ status: 'signed-out' })
    }
  }
}

/** Called by the sync engine when the server rejects our session. */
export function sessionExpired() {
  if (state.status === 'signed-in') set({ status: 'signed-out' })
}

export async function afterLogin(user: User) {
  const prev = cached()
  if (prev && prev.id !== user.id) await deleteUserDb(prev.id)
  signedIn(user)
}

export async function pendingCount(): Promise<number> {
  if (!db) return 0
  const counts = await Promise.all(
    [db.topics, db.notes, db.statuses, db.status_categories, db.attachments].map((t) => t.where('_dirty').equals(1).count()),
  )
  return counts.reduce((a, b) => a + b, 0)
}

/** Sign out and remove this device's copy of the data. */
export async function logout() {
  const u = currentUser()
  try {
    await api('/api/auth/logout', { method: 'POST' })
  } catch {
    /* offline: the cookie is cleared server-side on next login anyway */
  }
  localStorage.removeItem(CACHE_KEY)
  if (u) await deleteUserDb(u.id)
  set({ status: 'signed-out' })
}

export function refreshUser(user: User) {
  if (state.status === 'signed-in') signedIn(user, state.offline)
}
