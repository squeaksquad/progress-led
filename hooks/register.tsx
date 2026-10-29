import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Job, Task } from '../types'

// The Claude desktop app's task list is kept through these two tools; the mod
// follows their calls and keeps its own copy, stamped as each task completes.
const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
const WRAP_TOOL = 'mcp__ccd_turn__wrap_up'
// The mod's own tool, for jobs it cannot see the length of by itself.
const PROGRESS_TOOL = 'mcp__progress-led__progress'
const BAR_CELLS = 24
const SHOWN_DONE = 2
const SHOWN_JOBS = 3
const LABEL_CHARS = 56
// A finished job stays on the band this long.
const KEEP_FINISHED_MS = 20_000
// A shell command gets a row only once it has run this long, and leaves no trace if it ended sooner
// than QUICK_MS: quick commands are the work, not the news.
const SHOW_AFTER_MS = 3_000
const QUICK_MS = 5_000

const tasks = atom({ plugin: 'progress-led', key: 'tasks' } as const, [], { shape: 'tasks-1' })
const jobs = atom({ plugin: 'progress-led', key: 'jobs' } as const, [], { shape: 'jobs-1' })
// The clock the band draws with: moved once a second while a job runs.
const now = atom({ plugin: 'progress-led', key: 'now' } as const, 0)
// Whether the header has been clicked open to list every task.
const expanded = atom({ plugin: 'progress-led', key: 'expanded' } as const, false)

type PlanInput = {
  items?: { content?: unknown; status?: unknown }[]
  advance?: boolean
  done?: number[]
  start?: number
}

type ProgressInput = {
  id?: unknown
  label?: unknown
  seconds?: unknown
  done?: unknown
  total?: unknown
  finished?: unknown
}

const STATUSES = ['pending', 'in_progress', 'completed'] as const

function stamp(task: Task, at: number): Task {
  return task.status === 'completed' && task.completedAt === null ? { ...task, completedAt: at } : task
}

/** The task list after one update_plan call, as the app applies it. */
export function applyPlan(list: Task[], input: PlanInput, at: number): Task[] {
  let next = list
  if (Array.isArray(input.items)) {
    next = input.items.map(item => {
      const content = String(item.content ?? '')
      const status = STATUSES.find(s => s === item.status) ?? 'pending'
      // A task already completed under the same words keeps the time it was first done.
      const before = list.find(t => t.content === content && t.completedAt !== null)
      return { content, status, completedAt: status === 'completed' ? (before?.completedAt ?? null) : null }
    })
  }
  if (input.advance === true) {
    const current = next.findIndex(t => t.status === 'in_progress')
    const following = next.findIndex((t, i) => i > current && t.status === 'pending')
    next = next.map((t, i) =>
      i === current ? { ...t, status: 'completed' } : i === following ? { ...t, status: 'in_progress' } : t,
    )
  }
  if (Array.isArray(input.done)) {
    next = next.map((t, i) => (input.done!.includes(i + 1) ? { ...t, status: 'completed' } : t))
  }
  if (typeof input.start === 'number') {
    next = next.map((t, i) => (i + 1 === input.start ? { ...t, status: 'in_progress' } : t))
  }
  return next.map(t => stamp(t, at))
}

/** wrap_up checks off the step in progress. */
export function applyWrapUp(list: Task[], at: number): Task[] {
  return list.map(t => stamp(t.status === 'in_progress' ? { ...t, status: 'completed' } : t, at))
}

/**
 * How long a shell command says it runs, in seconds: `--seconds N`, `--duration N`,
 * `soak N`, `sleep N`, `timeout N`. Null when it does not say.
 */
export function commandSeconds(command: string): number | null {
  const patterns = [/--seconds[ =](\d+)/, /--duration[ =](\d+)/, /\bsoak (\d+)/, /\bsleep (\d+)(?!\.)/, /\btimeout (\d+)\b/]
  for (const pattern of patterns) {
    const match = pattern.exec(command)
    if (match?.[1] !== undefined) {
      const value = Number(match[1])
      if (value > 0) return value
    }
  }
  return null
}

/** A job's progress from 0 to 1, or null when only its elapsed time is known. */
export function fraction(job: Job, at: number): number | null {
  if (job.finishedAt !== null) return 1
  if (job.total !== null && job.total > 0 && job.done !== null) return Math.min(1, Math.max(0, job.done / job.total))
  if (job.seconds !== null && job.seconds > 0) return Math.min(1, Math.max(0, (at - job.startedAt) / (job.seconds * 1000)))
  return null
}

/** A job the tool reported, merged into the list (a new one, or an update of its id). */
export function applyProgress(list: Job[], input: ProgressInput, at: number, fallbackId: string): Job[] {
  const id = typeof input.id === 'string' && input.id !== '' ? input.id : typeof input.label === 'string' ? input.label : fallbackId
  const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const before = list.find(j => j.id === id && j.finishedAt === null)
  const job: Job = {
    id,
    label: typeof input.label === 'string' ? input.label : (before?.label ?? id),
    startedAt: before?.startedAt ?? at,
    seconds: number(input.seconds) ?? before?.seconds ?? null,
    done: number(input.done) ?? before?.done ?? null,
    total: number(input.total) ?? before?.total ?? null,
    finishedAt: input.finished === true ? at : null,
    source: 'tool',
  }
  return [...list.filter(j => j !== before), job]
}

/** Timed jobs past their length are finished; finished jobs leave after a minute. */
export function settle(list: Job[], at: number): Job[] {
  return list
    .map(j =>
      j.finishedAt === null && j.source === 'bash' && j.seconds !== null && at >= j.startedAt + j.seconds * 1000
        ? { ...j, finishedAt: j.startedAt + j.seconds * 1000 }
        : j,
    )
    .filter(j => j.finishedAt === null || at - j.finishedAt < KEEP_FINISHED_MS)
    .filter(j => !(j.source === 'bash' && j.finishedAt !== null && j.finishedAt - j.startedAt < QUICK_MS))
    .slice(-20)
}

/**
 * The job rows worth a line: running ones first (oldest first), then finished ones (newest first),
 * a shell command only once it has run SHOW_AFTER_MS, at most SHOWN_JOBS; `hidden` counts the rest.
 */
export function visibleJobs(list: Job[], at: number): { shown: Job[]; hidden: number } {
  const worth = settle(list, at).filter(j => j.source === 'tool' || j.finishedAt !== null || at - j.startedAt >= SHOW_AFTER_MS)
  const running = worth.filter(j => j.finishedAt === null).sort((a, b) => a.startedAt - b.startedAt)
  const finished = worth.filter(j => j.finishedAt !== null).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  const ordered = [...running, ...finished]
  return { shown: ordered.slice(0, SHOWN_JOBS), hidden: Math.max(0, ordered.length - SHOWN_JOBS) }
}

/** One task in the opened list: its mark, its number, its words and, once done, when. */
export function taskLine(task: Task, index: number): string {
  const mark = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '▸' : '○'
  const when = task.completedAt !== null ? ` · ${localTime(task.completedAt)}` : ''
  return `${mark} ${index + 1}. ${clip(task.content)}${when}`
}

/** A label cut to `chars`, with an ellipsis where it was cut. */
export function clip(text: string, chars = LABEL_CHARS): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`
}

/** A time of day in the viewer's own zone, e.g. "2:41 PM". */
export function localTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function clockText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const rest = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`
}

// The LED bar. Each segment is lit, unlit, or (the one progress has reached) lit partway.
export type Tone = 'green' | 'amber'
const LED_COLOR: Record<Tone, string> = { green: '#3ddc84', amber: '#ffb000' }
const SEGMENT_PX = 7
const GAP_PX = 2
const LED_HEIGHT_PX = 12

/** How brightly each of `cells` segments is lit, 0..1, for a bar at `share`. */
export function segments(share: number, cells = BAR_CELLS): number[] {
  const lit = Math.min(1, Math.max(0, share)) * cells
  return Array.from({ length: cells }, (_, i) => Math.min(1, Math.max(0, lit - i)))
}

/** For a job with no known length: one segment lit, moving one step a second. */
export function sweep(at: number, cells = BAR_CELLS): number[] {
  const step = Math.floor(at / 1000) % (2 * cells - 2)
  const index = step < cells ? step : 2 * cells - 2 - step
  return Array.from({ length: cells }, (_, i) => (i === index ? 1 : 0))
}

/** The bar as an SVG: rounded segments, lit ones glowing, unlit ones faint in either theme. */
export function ledSvg(levels: number[], tone: Tone): string {
  const color = LED_COLOR[tone]
  const width = levels.length * (SEGMENT_PX + GAP_PX) - GAP_PX
  const rects = levels
    .map((level, i) => {
      const x = i * (SEGMENT_PX + GAP_PX)
      const base = `<rect x="${x}" y="1" width="${SEGMENT_PX}" height="${LED_HEIGHT_PX - 2}" rx="1.5"`
      const off = `${base} fill="#808080" fill-opacity="0.22"/>`
      return level <= 0 ? off : `${off}${base} fill="${color}" fill-opacity="${level.toFixed(2)}" filter="url(#glow)"/>`
    })
    .join('')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LED_HEIGHT_PX}" viewBox="0 0 ${width} ${LED_HEIGHT_PX}">` +
    `<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="0.8" result="b"/>` +
    `<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${rects}</svg>`
  )
}

/** The bar as text, for a surface without SVG: lit `▮`, unlit `▯`; a segment lit halfway or more counts. */
export function ledText(levels: number[]): { lit: string; unlit: string } {
  const on = levels.filter(level => level >= 0.5).length
  return { lit: '▮'.repeat(on), unlit: '▯'.repeat(levels.length - on) }
}

let ticker: Timer | null = null

// Once a second while any job runs: the band redraws with the clock.
async function keepTicking($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await update($, jobs, list => settle(list, at))
  if (ticker !== null) return
  ticker = $.clock.every(1000, () => {
    void (async () => {
      const at = await $.clock.now()
      await update($, now, () => at)
      const list = await update($, jobs, current => settle(current, at))
      if (list.length === 0 && ticker !== null) {
        ticker.cancel()
        ticker = null
      }
    })()
  })
}

export const register: Register = on => {
  let counter = 0

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'progress',
      description:
        'Show progress of a long-running job (a timed test, a soak, a multi-step run) on the progress bar above ' +
        'the prompt. Call it when the job starts, with `label` and either `seconds` (its expected length) or ' +
        '`total` (steps); again with `done` as steps finish; and with `finished: true` when it ends. Reuse the ' +
        'same `id` (default: the label) for one job.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Names the job across calls; default the label.' },
          label: { type: 'string', description: 'What the bar says, e.g. "integration tests, 6 min".' },
          seconds: { type: 'number', description: 'Expected length in seconds, for a timed job.' },
          done: { type: 'number', description: 'Steps finished so far, for a counted job.' },
          total: { type: 'number', description: 'Steps in all, for a counted job.' },
          finished: { type: 'boolean', description: 'True when the job has ended.' },
        },
      },
    })
    if ((await read($, jobs)).some(j => j.finishedAt === null)) await keepTicking($)
    return started
  })

  on('tool.call', { tool: PLAN_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const at = await $.clock.now()
      await update($, tasks, list => applyPlan(list, e as PlanInput, at))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: WRAP_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      const at = await $.clock.now()
      await update($, tasks, list => applyWrapUp(list, at))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const at = await $.clock.now()
    counter += 1
    const list = await update($, jobs, current => applyProgress(current, e as ProgressInput, at, `job-${counter}`))
    if (list.some(j => j.finishedAt === null)) await keepTicking($)
    const job = list[list.length - 1]
    const share = job === undefined ? null : fraction(job, at)
    return { result: `Progress shown: ${job?.label ?? 'job'}${share === null ? '' : ` at ${Math.round(share * 100)}%`}.` }
  }).catch(() => ({ result: 'Progress not shown: the progress-led mod failed.' }))

  // A shell command: a foreground one is timed from start to end; a background one
  // only when it says how long it runs.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const seconds = commandSeconds(e.command)
    const background = e.run_in_background === true
    if (background && seconds === null) return next(e)
    const at = await $.clock.now()
    counter += 1
    const job: Job = {
      id: `bash-${e.tool_use_id}`,
      label: (e.description ?? e.command).slice(0, 60),
      startedAt: at,
      seconds,
      done: null,
      total: null,
      finishedAt: null,
      source: 'bash',
    }
    await update($, jobs, list => [...list, job])
    await keepTicking($)
    const ran = await next(e)
    if (!background) {
      const end = await $.clock.now()
      await update($, jobs, list => list.map(j => (j.id === job.id ? { ...j, finishedAt: end } : j)))
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, tasks)
    const running = await read($, jobs)
    if (e.props.hasSurvey || (list.length === 0 && running.length === 0)) return next(e)

    const at = Math.max(await read($, now), ...running.map(j => j.startedAt))
    const { Box, Button, Text } = $.ui.resolve(e)
    const isOpen = await read($, expanded)
    const elements = $.ui.resolve(e)
    // The terminal's table carries an Svg that draws nothing: it gets the text bar.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    // An LED bar: an image where the surface draws SVG, `▮▯` text where it does not.
    const led = (levels: number[], tone: Tone, alt: string) => {
      if (Svg !== undefined) return <Svg source={ledSvg(levels, tone)} alt={alt} />
      const { lit, unlit } = ledText(levels)
      return (
        <Text mono>
          <Text color={tone === 'green' ? 'green' : 'yellow'}>{lit}</Text>
          <Text dimColor>{unlit}</Text>
        </Text>
      )
    }
    const done = list.filter(t => t.status === 'completed')
    const current = list.find(t => t.status === 'in_progress')
    // The task in progress counts by its timed jobs' share, so the bar moves while they run.
    const active = running.filter(j => j.finishedAt === null)
    const shares = active.map(j => fraction(j, at)).filter((s): s is number => s !== null)
    const partial = current !== undefined && shares.length > 0 ? Math.min(...shares) : 0
    const overall = list.length === 0 ? 0 : (done.length + partial) / list.length
    const stamped = done.filter(t => t.completedAt !== null).sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
    const recent = stamped.slice(-SHOWN_DONE)
    const earlier = stamped.length - recent.length
    const { shown, hidden } = visibleJobs(running, at)

    return (
      <Box flexDirection="column">
        {list.length > 0 && (
          // The same row as a job's: the bar in the first column, then the words. Only the words are the
          // button, since a desktop draws a native button around whatever it holds, and its padding moved
          // this bar out of line with the job bars beneath.
          <Box flexDirection="row" gap={1} alignItems="center">
            {led(segments(overall), 'green', `${(overall * 100).toFixed(1)}% of the tasks`)}
            <Button key="tasks-toggle" plain onPress={() => void update($, expanded, open => !open)}>
              <Text tabular>
                {done.length}/{list.length} tasks · {(overall * 100).toFixed(1)}% {isOpen ? '▴' : '▾'}
              </Text>
            </Button>
          </Box>
        )}
        {isOpen &&
          list.map((t, i) => (
            <Text key={`task-${i}`} dimColor={t.status !== 'in_progress'}>
              {taskLine(t, i)}
            </Text>
          ))}
        {!isOpen && current !== undefined && <Text>▸ {clip(current.content, LABEL_CHARS + 8)}</Text>}
        {shown.map(job => {
          const share = fraction(job, at)
          const elapsed = ((job.finishedAt ?? at) - job.startedAt) / 1000
          const timing =
            job.finishedAt !== null
              ? `done ${localTime(job.finishedAt)} · took ${clockText(elapsed)}`
              : job.total !== null && job.done !== null
                ? `${job.done}/${job.total} · ${clockText(elapsed)}`
                : job.seconds !== null
                  ? `${clockText(elapsed)} / ${clockText(job.seconds)} · ends ${localTime(job.startedAt + job.seconds * 1000)}`
                  : `${clockText(elapsed)} elapsed`
          return (
            <Box key={job.id} flexDirection="row" gap={1} alignItems="center">
              {led(
                share === null ? sweep(at) : segments(share),
                job.finishedAt === null ? 'amber' : 'green',
                share === null ? `${job.label}, running` : `${job.label}, ${Math.round(share * 100)}%`,
              )}
              <Text dimColor={job.finishedAt !== null} tabular>
                {clip(job.label)} · {timing}
              </Text>
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>  +{hidden} more</Text>}
        {!isOpen &&
          recent.map(t => (
            <Text key={t.content} dimColor>
              ✓ {localTime(t.completedAt ?? 0)} {clip(t.content)}
            </Text>
          ))}
        {!isOpen && earlier > 0 && <Text dimColor>  +{earlier} done earlier</Text>}
      </Box>
    )
  })
}
