import { create } from 'zustand'

// ── Loading task store ──────────────────────────────────────────────────────────
// A tiny, dedicated store for *transient* "something is loading" UI, kept separate
// from the big workspace store on purpose: these tasks are ephemeral chrome (they
// come and go within seconds and shouldn't re-render every workspace subscriber),
// and any subsystem can drive them without reaching into workspace state.
//
// A task is rendered by <LoadingOverlay/>. Two presentations:
//   • 'overlay' — a centred, backdrop-blurred card for work the user is actively
//     waiting on (e.g. they clicked the mic and the Whisper model must load first).
//   • 'ambient' — a small bottom-corner pill for background work the user need not
//     wait for (e.g. the startup model preload).
// `dismissLoading` downgrades an overlay to an ambient pill so the user can keep
// working while a long load finishes ("Continue in background").

export type LoadingVariant = 'overlay' | 'ambient'

export interface LoadingTask {
  id: string
  /** Headline — *what* is loading (already localised by the caller). */
  title: string
  /** Optional secondary line (e.g. model name + download size). */
  detail?: string
  /** Optional reassuring footnote shown on the overlay card only. */
  hint?: string
  /** 0–100 for a determinate bar/ring, or null for an indeterminate "preparing" state. */
  progress: number | null
  variant: LoadingVariant
  /** When true (default), the overlay shows a "Continue in background" affordance. */
  dismissible?: boolean
}

interface LoadingState {
  tasks: Record<string, LoadingTask>
  /** Create or replace a task by id (idempotent upsert). */
  startLoading: (id: string, task: Omit<LoadingTask, 'id'>) => void
  /** Patch an existing task (no-op if it's already gone). */
  updateLoading: (id: string, patch: Partial<Omit<LoadingTask, 'id'>>) => void
  /** Remove a task (the load finished or failed). */
  finishLoading: (id: string) => void
  /** Downgrade an overlay task to an ambient pill; the underlying load keeps going. */
  dismissLoading: (id: string) => void
}

export const useLoadingStore = create<LoadingState>((set) => ({
  tasks: {},

  startLoading: (id, task) =>
    set(s => ({ tasks: { ...s.tasks, [id]: { dismissible: true, ...task, id } } })),

  updateLoading: (id, patch) =>
    set(s => {
      const cur = s.tasks[id]
      if (!cur) return s
      return { tasks: { ...s.tasks, [id]: { ...cur, ...patch } } }
    }),

  finishLoading: (id) =>
    set(s => {
      if (!s.tasks[id]) return s
      const next = { ...s.tasks }
      delete next[id]
      return { tasks: next }
    }),

  dismissLoading: (id) =>
    set(s => {
      const cur = s.tasks[id]
      if (!cur) return s
      return { tasks: { ...s.tasks, [id]: { ...cur, variant: 'ambient' } } }
    }),
}))
