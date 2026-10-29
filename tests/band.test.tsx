import { expect, test } from 'claude-code/testing'

import { clip, clockText, commandSeconds, ledSvg, ledText, localTime, segments, sweep } from '../hooks/register'

/** Lit segments in an LED SVG. */
const litIn = (source: unknown) => (String(source).match(/filter="url\(#glow\)"/g) ?? []).length
const segmentsIn = (source: unknown) => (String(source).match(/fill="#808080"/g) ?? []).length

const BAND = {
  plugin: 'progress-led',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: true,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan'
const PROGRESS = 'mcp__progress-led__progress'

test('a time reads as a time of day', () => {
  expect(/\d{1,2}[:.]\d{2}/.test(localTime(Date.UTC(2026, 9, 29, 14, 41)))).toBe(true)
})

test('the band follows the task list and stamps completions in local time', async ($, on) => {
  const at = Date.UTC(2026, 9, 29, 14, 41)
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: at }))

  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Read the plan', status: 'in_progress' },
      { content: 'Make the change', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
      { content: 'Commit', status: 'pending' },
    ],
  })
  await $.tool.call({ tool: PLAN, advance: true })
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /tasks/ }))?.text).toBe('2/4 tasks · 50.0% ▾')
    if (surface === 'desktop') {
      const led = await ui.find({ type: 'Svg' })
      expect(segmentsIn(led?.props.source)).toBe(24)
      expect(litIn(led?.props.source)).toBe(12)
    } else {
      expect((await ui.find({ type: 'Text', text: /▮/ }))?.text).toBe('▮'.repeat(12) + '▯'.repeat(12))
    }
    expect((await ui.find({ type: 'Text', text: /Read the plan/ }))?.text).toBe(`✓ ${localTime(at)} Read the plan`)
    expect((await ui.find({ type: 'Text', text: /Make the change/ }))?.text?.startsWith('✓ ')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /Run the tests/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('a timed job fills its bar with the clock and moves the overall bar', async ($, on) => {
  const start = Date.UTC(2026, 9, 29, 15, 0)
  let clock = start
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: clock }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.register', () => ({ value: { tool: PROGRESS } }))

  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Measure', status: 'in_progress' },
      { content: 'Record', status: 'pending' },
    ],
  })
  await $.tool.call({ tool: PROGRESS, label: 'bitexact 360 s', seconds: 360 })
  clock = start + 90_000
  // One more call stands for the ticker's second: it reads the clock as the ticker would.
  await $.tool.call({ tool: PROGRESS, label: 'bitexact 360 s' })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const job = await ui.find({ type: 'Text', text: /bitexact/ })
  expect(job?.text).toBe(`bitexact 360 s · 1:30 / 6:00 · ends ${localTime(start + 360_000)}`)
  expect((await ui.find({ type: 'Text', text: /tasks/ }))?.text).toBe('0/2 tasks · 12.5% ▾')
  await ui.unmount()

  await $.tool.call({ tool: PROGRESS, label: 'bitexact 360 s', finished: true })
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /bitexact/ }))?.text).toBe(
    `bitexact 360 s · done ${localTime(clock)} · took 1:30`,
  )
  await after.unmount()
})

test('a counted job shows its steps', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  await $.tool.call({ tool: PROGRESS, id: 'runs', label: 'catch runs', total: 4, done: 1 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /catch runs/ }))?.text).toBe('catch runs · 1/4 · 0:00')
  expect(litIn((await ui.find({ type: 'Svg' }))?.props.source)).toBe(6)
  await ui.unmount()
})

test('nothing shows before there is a task list or a job', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('commands that say their length are timed', () => {
  expect(commandSeconds('usb16x16-latency bitexact --seconds 360 --loop-channels 8')).toBe(360)
  expect(commandSeconds('measure-candidate.sh soak 600 32')).toBe(600)
  expect(commandSeconds('sleep 20; ssh pi true')).toBe(20)
  expect(commandSeconds('git status')).toBe(null)
})

test('the LED bar lights whole segments and the one reached partway', () => {
  expect(segments(0, 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  expect(segments(0.75, 8)).toEqual([1, 1, 1, 1, 1, 1, 0, 0])
  expect(segments(1 / 16, 8)).toEqual([0.5, 0, 0, 0, 0, 0, 0, 0])
  expect(segments(1, 4)).toEqual([1, 1, 1, 1])
  expect(ledText(segments(0.5, 8))).toEqual({ lit: '▮▮▮▮', unlit: '▯▯▯▯' })
  const svg = ledSvg(segments(0.5, 8), 'amber')
  expect(segmentsIn(svg)).toBe(8)
  expect(litIn(svg)).toBe(4)
  expect(svg.includes('#ffb000')).toBe(true)
  expect(clockText(3725)).toBe('1:02:05')
  expect(clockText(90)).toBe('1:30')
})

test('a job of no known length sweeps one segment back and forth', () => {
  expect(sweep(0, 4)).toEqual([1, 0, 0, 0])
  expect(sweep(3_000, 4)).toEqual([0, 0, 0, 1])
  expect(sweep(4_000, 4)).toEqual([0, 0, 1, 0])
  expect(sweep(6_000, 4)).toEqual([1, 0, 0, 0])
})

test('quick commands leave no row; a long one does, and the rows stay few', async ($, on) => {
  let clock = 2_000_000
  on('clock.now', () => ({ value: clock }))
  on('clock.every', () => ({ value: undefined }))
  // The engine beneath: each Bash call takes the time its description says.
  on('tool.call', (_, e) => {
    if (e.tool === 'Bash') clock += Number(/(\d+) ms/.exec(String(e.description))?.[1] ?? 0)
    return { result: {} }
  })

  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Bash', command: 'git status', description: `status ${i} 200 ms` })
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'build 8000 ms' })
  for (let i = 0; i < 4; i++) await $.tool.call({ tool: PROGRESS, id: `j${i}`, label: `job ${i}`, seconds: 600 })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /status/ })).toBe(undefined)
  // Running first, oldest first: three of the four tool jobs, the rest counted.
  expect((await ui.find({ type: 'Text', text: /job 0/ }))?.text?.startsWith('job 0 · ')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /job 3/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /more/ }))?.text).toBe('  +2 more')
  await ui.unmount()
})

test('many quick completions fold into a count', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 3_000_000 }))
  const items = Array.from({ length: 7 }, (_, i) => ({ content: `step ${i}`, status: i < 6 ? 'completed' : 'in_progress' }))
  await $.tool.call({ tool: PLAN, items })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /earlier/ }))?.text).toBe('  +4 done earlier')
  expect((await ui.find({ type: 'Text', text: /▸/ }))?.text).toBe('▸ step 6')
  await ui.unmount()
})

test('long labels are cut', () => {
  expect(clip('short')).toBe('short')
  expect(clip('x'.repeat(80), 10)).toBe('xxxxxxxxx…')
})

test('a click on the header lists every task, and another folds it', async ($, on) => {
  const at = Date.UTC(2026, 9, 29, 15, 20)
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: at }))
  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Read the plan', status: 'completed' },
      { content: 'Make the change', status: 'in_progress' },
      { content: 'Run the tests', status: 'pending' },
    ],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /3\. Run the tests/ })).toBe(undefined)
    await ui.press({ key: 'tasks-toggle' })
    expect((await ui.find({ type: 'Text', text: /tasks ·/ }))?.text).toBe('1/3 tasks · 33.3% ▴')
    expect((await ui.find({ type: 'Text', text: /1\. Read/ }))?.text).toBe(`✓ 1. Read the plan · ${localTime(at)}`)
    expect((await ui.find({ type: 'Text', text: /2\. Make/ }))?.text).toBe('▸ 2. Make the change')
    expect((await ui.find({ type: 'Text', text: /3\. Run/ }))?.text).toBe('○ 3. Run the tests')
    await ui.press({ key: 'tasks-toggle' })
    expect(await ui.find({ type: 'Text', text: /3\. Run the tests/ })).toBe(undefined)
    await ui.unmount()
  }
})

test('every bar is the same 24 segments: an image on the desktop, monospaced text in the terminal', async ($, on) => {
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 4_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  await $.tool.call({ tool: PLAN, items: [{ content: 'Measure', status: 'in_progress' }] })
  await $.tool.call({ tool: PROGRESS, id: 'a', label: 'timed', seconds: 100 })
  await $.tool.call({ tool: PROGRESS, id: 'b', label: 'counted', total: 3, done: 1 })
  await $.tool.call({ tool: PROGRESS, id: 'c', label: 'open-ended' })
  const desktop = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const images = await desktop.findAll({ type: 'Svg' })
  expect(images.length).toBe(4)
  for (const one of images) expect(segmentsIn(one.props.source)).toBe(24)
  await desktop.unmount()
  const terminal = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const rows = (await terminal.findAll({ type: 'Text', text: /^[▮▯]+$/ })).filter(one => one.props.mono === true)
  expect(rows.length).toBe(4)
  for (const one of rows) expect([...one.text].length).toBe(24)
  await terminal.unmount()
})
