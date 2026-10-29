export type Task = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Milliseconds since the epoch when it was first seen completed; null until then. */
  completedAt: number | null
}

/** A timed or counted job: a test run, a soak, a long command. */
export type Job = {
  id: string
  label: string
  startedAt: number
  /** Expected length; null when only the elapsed time is known. */
  seconds: number | null
  /** Counted progress, when the job reports steps rather than time. */
  done: number | null
  total: number | null
  /** When it ended; null while it runs. */
  finishedAt: number | null
  source: 'tool' | 'bash'
}

declare module 'claude-code' {
  interface PluginState {
    'progress-led': { tasks: Shaped<Task[]>; jobs: Shaped<Job[]>; now: number; expanded: boolean }
  }
}
