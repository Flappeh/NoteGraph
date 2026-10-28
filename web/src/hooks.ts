import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useState } from 'react'
import { alive, bySort, db, type Note, type Status, type StatusCategory, type Topic } from './db'

const EMPTY: never[] = []

export const useTopics = (): Topic[] =>
  useLiveQuery(async () => alive(await db.topics.toArray()).sort(bySort), []) ?? EMPTY

export const useAllNotes = (): Note[] => useLiveQuery(async () => alive(await db.notes.toArray()), []) ?? EMPTY

export const useCategories = (): StatusCategory[] =>
  useLiveQuery(async () => alive(await db.status_categories.toArray()).sort(bySort), []) ?? EMPTY

export const useStatuses = (): Status[] =>
  useLiveQuery(async () => alive(await db.statuses.toArray()).sort(bySort), []) ?? EMPTY

/** Map helpers for quick lookups. */
export function useStatusMap() {
  const statuses = useStatuses()
  const categories = useCategories()
  return {
    statuses,
    categories,
    status: new Map(statuses.map((s) => [s.id, s])),
    category: new Map(categories.map((c) => [c.id, c])),
  }
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => window.matchMedia(q).matches)
  useEffect(() => {
    const mq = window.matchMedia(q)
    const on = () => setM(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [q])
  return m
}

/** Persist a small piece of UI state per device. */
export function useLocalState<T>(key: string, init: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? init : (JSON.parse(raw) as T)
    } catch {
      return init
    }
  })
  return [
    v,
    (nv: T) => {
      setV(nv)
      try {
        localStorage.setItem(key, JSON.stringify(nv))
      } catch {
        /* storage unavailable */
      }
    },
  ]
}
