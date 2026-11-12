import { expect, test } from 'claude-code/testing'

import type { DictationView } from '../types'

const BAND = {
  plugin: 'push-to-talk-dictation',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 60,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const BASE: DictationView = {
  phase: 'idle',
  mode: null,
  levels: [],
  elapsedMs: 0,
  text: '',
  isBoxLive: true,
  hotkey: 'Right Ctrl',
  isOwner: true,
  hasKey: true,
  notice: null,
  noticeKind: null,
}

// What the engine holds for the shaped atom `view`, as an earlier write left it.
function seeded(view: DictationView) {
  return () => ({ value: { value: { shape: 'view-2', value: view }, version: 1 } })
}

test('while dictating, the band mirrors the native toolbar: Listening…, waveform, timer, Done and Cancel', async ($, on) => {
  on('state.get', seeded({ ...BASE, phase: 'listening', mode: 'hold', elapsedMs: 7300, levels: [0.1, 0.5, 1] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /^Listening…$/ }))?.text).toBe('Listening…')
    expect((await ui.find({ type: 'Text', text: /0:07/ }))?.text).toBe('0:07')
    expect((await ui.find({ type: 'Text', text: /Release Right Ctrl/ }))?.text).toBe('Release Right Ctrl to finish · Esc cancels')
    expect(await ui.find({ key: 'done' })).toBeDefined()
    expect(await ui.find({ key: 'cancel' })).toBeDefined()
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Text', text: /█/ }))?.text).toBe('▁▁▁▁▁▁▁▁▁▁▁▁▁▂▅█')
    }
    await ui.unmount()
  }
})

test('on the desktop the band draws the filled mic and a bar waveform', async ($, on) => {
  on('state.get', seeded({ ...BASE, phase: 'listening', mode: 'hold', levels: [0.5, 1] }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const svgs: string[] = []
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: string; props?: { source?: string }; children?: unknown[] }
    if (n.type === 'Svg' && n.props?.source) svgs.push(n.props.source)
    for (const child of n.children ?? []) walk(child)
  }
  walk(await ui.find({ type: 'Box' }))
  expect(svgs.length).toBe(2)
  expect(svgs[0]).toContain('<rect x="360" y="90" width="280" height="500" rx="140" fill="#d97757"/>') // the filled capsule
  expect(svgs[1]).toContain('height="16" rx="1.5" fill="#d97757"') // the loudest bar
  await ui.unmount()
})

test('hands-free mode says how to finish', async ($, on) => {
  on('state.get', seeded({ ...BASE, phase: 'listening', mode: 'locked' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Tap Right Ctrl/ }))?.text).toBe('Tap Right Ctrl or click Done to finish · Esc cancels')
  await ui.unmount()
})

test('by default the transcript stays out of sight until you finish', async ($, on) => {
  on('state.get', seeded({ ...BASE, phase: 'listening', mode: 'hold', isBoxLive: false, text: 'refactor the parser' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /refactor/ })).toBeUndefined()
  await ui.unmount()
})

test('with live text on and no prompt box, the transcript shows in the band', { options: { liveText: true } }, async ($, on) => {
  on('state.get', seeded({ ...BASE, phase: 'listening', mode: 'hold', isBoxLive: false, text: 'refactor the parser' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /refactor/ }))?.text).toBe('refactor the parser')
  await ui.unmount()
})

test('idle, the band shows the mic, a Dictate button and the hold key', async ($, on) => {
  on('state.get', seeded(BASE))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /press and hold/ }))?.text).toBe('or press and hold Right Ctrl to record')
    expect(await ui.find({ key: 'dictate' })).toBeDefined()
    await ui.unmount()
  }
})

test('when another session holds the key, the idle bar says how to bring it here', async ($, on) => {
  on('state.get', seeded({ ...BASE, isOwner: false }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /another session/ }))?.text).toBe('Right Ctrl is with another session; type here to bring it back')
  expect(await ui.find({ type: 'Text', text: /press and hold/ })).toBeUndefined()
  expect(await ui.find({ key: 'dictate' })).toBeDefined()
  await ui.unmount()
})

test('finishing reads as the native one does', async ($, on) => {
  on('state.get', seeded({ ...BASE, phase: 'finishing' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Finishing/ }))?.text).toBe('Finishing dictation…')
  await ui.unmount()
})

test('without an API key, the button leads to setup and the notice says why', async ($, on) => {
  on('state.get', seeded({ ...BASE, hasKey: false, notice: 'Live dictation needs an OpenAI API key. Run /dictate setup.', noticeKind: 'error' }))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /needs an OpenAI API key/ }))?.text).toBe('Live dictation needs an OpenAI API key. Run /dictate setup.')
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()
  await ui.unmount()
})

test('a survey keeps the band', async ($, on) => {
  on('state.get', seeded({ ...BASE, phase: 'listening', mode: 'hold' }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })

  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  await ui.unmount()
})
