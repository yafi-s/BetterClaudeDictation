import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptDecoration, Register } from 'claude-code'

import type { DictationView } from '../types'
import { micSvg, waveSvg } from './icons'

// Colours like Claude Desktop's own mic: a muted grey at rest (legible on the light and
// dark themes alike) and Claude's orange while listening.
const IDLE_COLOR = '#8f8d86'
const LIVE_COLOR = '#d97757'

// Live dictation, modeled on the Codex app's: hold a key and talk, the words
// stream into the prompt box as you speak (dim until final), release to keep
// them. The heavy lifting runs outside the module: helper/dictation-helper.mjs
// (OpenAI gpt-live-transcribe over a WebSocket) and native/voicekit.exe (mic
// and global push-to-talk key).

type Engine = EngineInterface

const PROMPT_CONTEXT =
  'Someone dictating a message to Claude Code, an AI coding assistant. Expect software terms, file and folder names, shell commands, and code identifiers.'

const IDLE: DictationView = {
  phase: 'starting',
  mode: null,
  levels: [],
  elapsedMs: 0,
  text: '',
  isBoxLive: true,
  hotkey: '',
  isOwner: true,
  hasKey: false,
  notice: null,
  noticeKind: null,
}

// Change the tag when DictationView's fields change: it declines a value an
// earlier version stored, which outlives a reload.
const view = atom({ plugin: 'push-to-talk-dictation', key: 'view' } as const, IDLE, { shape: 'view-2' })

const BARS = '▁▂▃▄▅▆▇█'
const WAVE_WIDTH = 16

type HelperEvent = { type: string; [field: string]: any }

type Segment = { id: number; text: string; stable: number; isFinal: boolean }

// Where dictated text goes: between `before` and `after`, the draft split at
// the caret when dictation began. Back-to-back dictations share one region.
type Region = {
  before: string
  after: string
  segments: Segment[]
  lastWritten: string
  lastKey: string
  isDetached: boolean
}

function list(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

function mmss(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function wave(levels: number[]): string {
  const recent = levels.slice(-WAVE_WIDTH)
  const padded = [...Array(Math.max(0, WAVE_WIDTH - recent.length)).fill(0), ...recent]
  return padded.map(l => BARS[Math.min(BARS.length - 1, Math.round(l * (BARS.length - 1)))]).join('')
}

function compose(r: Region): { text: string; cursor: number; decorations: PromptDecoration[] } {
  const parts = r.segments.filter(s => s.text)
  const body = parts.map(s => s.text).join(' ')
  const lead = r.before && body && !/\s$/.test(r.before) ? ' ' : ''
  const trail = r.after && body && !/^\s/.test(r.after) ? ' ' : ''
  const head = r.before + lead
  const decorations: PromptDecoration[] = []
  let offset = head.length
  for (const s of parts) {
    if (!s.isFinal && s.stable < s.text.length) {
      decorations.push({ start: offset + s.stable, end: offset + s.text.length, dimColor: true })
    }
    offset += s.text.length + 1
  }
  return { text: head + body + trail + r.after, cursor: head.length + body.length, decorations }
}

// Module state: a reload starts it over (register and session.start run
// again, and the engine ends the old helper with the old module).
let helperConfig = {
  hotkey: 'right-ctrl',
  device: '',
  languages: ['en'] as string[],
  keywords: [] as string[],
  prompt: PROMPT_CONTEXT,
  delay: 'low',
}
let showIdleBar = true
let liveText = false
let ownsKey = true // mirrors the helper's last `owner` event
let isCheckingKey = false // a new key was saved; the next ready stream confirms it

const SETUP_HINT = 'Click Set up dictation (or run /dictate key).'

let control: { port: number; token: string } | null = null
let keyFile = ''
let region: Region | null = null
let isWriting = false
let writeAgain = false
let listeningId: number | null = null
const finishing = new Set<number>()
const toClipboard = new Set<number>() // dictations whose region the person edited
let lastLevelMs = -1000

function setView($: Engine, patch: Partial<DictationView>) {
  return update($, view, v => ({ ...v, ...patch }))
}

async function send($: Engine, command: string): Promise<any> {
  if (!control) return { ok: false, error: 'Dictation is still starting.' }
  const r = await $.http.fetch(`http://127.0.0.1:${control.port}/cmd?c=${command}`, {
    method: 'POST',
    headers: { 'x-token': control.token },
  })
  return r.ok ? JSON.parse(r.text) : { ok: false, error: `helper answered ${r.status}` }
}

// ---- the prompt box ------------------------------------------------------

async function beginSegment($: Engine, id: number) {
  const segment: Segment = { id, text: '', stable: 0, isFinal: false }
  if (region && !region.isDetached) {
    region.segments.push(segment)
    return
  }
  const box = await $.prompt.read()
  region = {
    before: box.text.slice(0, box.cursor),
    after: box.text.slice(box.cursor),
    segments: [segment],
    lastWritten: box.text,
    lastKey: '',
    isDetached: false,
  }
}

function segmentOf(id: number): Segment | undefined {
  return region?.segments.find(s => s.id === id)
}

async function flush($: Engine) {
  if (isWriting) {
    writeAgain = true
    return
  }
  isWriting = true
  try {
    do {
      writeAgain = false
      const r = region
      if (!r || r.isDetached) break
      const { text, cursor, decorations } = compose(r)
      const key = `${text}\u0000${JSON.stringify(decorations)}`
      if (key === r.lastKey) continue
      const box = await $.prompt.read()
      if (box.text !== r.lastWritten) {
        // The person changed the draft mid-dictation: stop writing over it.
        r.isDetached = true
        for (const s of r.segments) if (!s.isFinal) toClipboard.add(s.id)
        $.ui.toast('You edited the prompt while dictating; the rest of this dictation goes to the clipboard.')
        break
      }
      const filled = await $.prompt.fill({ text, mode: 'replace', cursor, decorations })
      if (!filled.isFilled) {
        r.isDetached = true
        for (const s of r.segments) if (!s.isFinal) toClipboard.add(s.id)
        await setView($, { isBoxLive: false })
        break
      }
      r.lastWritten = filled.text
      r.lastKey = key
    } while (writeAgain)
  } finally {
    isWriting = false
  }
  const r = region
  if (r && listeningId === null && r.segments.every(s => s.isFinal) && !writeAgain) {
    if (r === region) region = null
  }
}

async function settleToClipboard($: Engine, text: string) {
  if (!text) return
  const copied = await $.ui.copy({ text })
  $.ui.toast(copied.isCopied ? 'Dictation copied to the clipboard; paste with Ctrl+V.' : `Dictation: ${text}`)
}

// ---- helper events -------------------------------------------------------

async function handle($: Engine, ev: HelperEvent) {
  switch (ev.type) {
    case 'ready': {
      control = { port: ev.port, token: ev.token }
      keyFile = ev.keyFile
      const keyNotice = !ev.hasKey && ev.keyProblem ? `${ev.keyProblem} ${SETUP_HINT}` : null
      await setView($, {
        phase: 'idle',
        hotkey: ev.hotkey,
        hasKey: ev.hasKey,
        notice: keyNotice,
        noticeKind: keyNotice ? 'error' : null,
      })
      return
    }
    case 'owner':
      ownsKey = ev.isOwner
      await setView($, { isOwner: ev.isOwner })
      return
    case 'needs-key':
      keyFile = ev.keyFile
      await setView($, { hasKey: false, notice: `${ev.problem ?? 'Live dictation needs an OpenAI API key.'} ${SETUP_HINT}`, noticeKind: 'error' })
      return
    case 'key-updated':
      if (ev.hasKey) {
        isCheckingKey = true
        await setView($, { hasKey: true, notice: 'Key saved. Checking it with OpenAI…', noticeKind: 'info' })
      } else {
        await setView($, { hasKey: false, notice: `${ev.problem} ${SETUP_HINT}`, noticeKind: 'error' })
      }
      return
    case 'stream':
      if (ev.state === 'ready' && isCheckingKey) {
        isCheckingKey = false
        await setView($, { hasKey: true, notice: null, noticeKind: null })
        const v = await read($, view)
        $.ui.toast(v.hotkey ? `OpenAI accepted the key. Hold ${v.hotkey} and talk.` : 'OpenAI accepted the key. Click Dictate and talk.')
      }
      return
    case 'state': {
      if (ev.phase === 'listening' && ev.id !== listeningId) {
        listeningId = ev.id
        lastLevelMs = -1000
        await beginSegment($, ev.id)
        await setView($, { phase: 'listening', mode: ev.mode, levels: [], elapsedMs: 0, text: '', notice: null, noticeKind: null })
        return
      }
      if (ev.phase === 'finishing') finishing.add(ev.id)
      if (ev.state === 'listening') {
        await setView($, { phase: 'listening', mode: ev.mode })
        return
      }
      if (listeningId === ev.id) listeningId = null
      await setView($, { phase: finishing.size > 0 ? 'finishing' : 'idle', mode: null })
      return
    }
    case 'level': {
      if (ev.elapsedMs - lastLevelMs < 110) return
      lastLevelMs = ev.elapsedMs
      await update($, view, v => ({ ...v, elapsedMs: ev.elapsedMs, levels: [...v.levels, ev.level].slice(-WAVE_WIDTH) }))
      return
    }
    case 'transcript': {
      // Off by default: like Claude's own mic, the text lands once you finish.
      // The helper still streams while you talk, so the final is ready ~0.5 s
      // after you stop instead of after a whole upload.
      if (!liveText) return
      const s = segmentOf(ev.id)
      if (s && !s.isFinal) {
        s.text = ev.text
        s.stable = ev.stable
        void flush($)
      }
      await setView($, { text: ev.text })
      return
    }
    case 'final': {
      finishing.delete(ev.id)
      const s = segmentOf(ev.id)
      if (s) {
        s.text = ev.text
        s.stable = ev.text.length
        s.isFinal = true
        void flush($)
      }
      if (toClipboard.delete(ev.id)) await settleToClipboard($, ev.text)
      else if (!s && ev.text) await settleToClipboard($, ev.text)
      if (ev.isSilent) $.ui.toast('No speech detected. Check the microphone, or /dictate devices.')
      await setView($, { phase: listeningId !== null ? 'listening' : finishing.size > 0 ? 'finishing' : 'idle' })
      return
    }
    case 'canceled': {
      finishing.delete(ev.id)
      toClipboard.delete(ev.id)
      if (listeningId === ev.id) listeningId = null
      if (region) {
        region.segments = region.segments.filter(s => s.id !== ev.id)
        void flush($)
      }
      if (!ev.quiet) $.ui.toast('Dictation canceled.')
      await setView($, { phase: finishing.size > 0 ? 'finishing' : 'idle', mode: null, text: '' })
      return
    }
    case 'error':
      if (ev.isAuth) isCheckingKey = false
      await setView($, { notice: ev.message, noticeKind: 'error', ...(ev.isAuth ? { hasKey: false } : {}) })
      return
    case 'warning':
      $.ui.log(`push-to-talk-dictation: ${ev.message}`, { to: 'debug' })
      return
    default:
      $.ui.log(`push-to-talk-dictation: ${JSON.stringify(ev)}`, { to: 'debug' })
  }
}

async function runHelper($: Engine) {
  const helper = `${$.plugin.root}/helper/dictation-helper.mjs`
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await setView($, { phase: 'starting' })
      const child = $.process.spawn({
        argv: ['node', helper],
        env: { LIVE_DICTATION_CONFIG: JSON.stringify(helperConfig) },
      })
      let pending = ''
      for await (const piece of child) {
        if (piece.stream === 'stderr') {
          $.ui.log(`push-to-talk-dictation helper: ${piece.text.trim()}`, { to: 'debug' })
          continue
        }
        pending += piece.text
        let nl = pending.indexOf('\n')
        while (nl >= 0) {
          const line = pending.slice(0, nl).trim()
          pending = pending.slice(nl + 1)
          if (line) await handle($, JSON.parse(line))
          nl = pending.indexOf('\n')
        }
      }
    } catch (error) {
      $.ui.log(`push-to-talk-dictation helper failed: ${String(error)}`, { to: 'debug' })
    }
    control = null
    listeningId = null
    finishing.clear()
    try {
      await setView($, { phase: 'unavailable', notice: 'The dictation helper stopped; restarting.', noticeKind: 'warning' })
      await $.clock.sleep(2000 * (attempt + 1))
    } catch {
      return // the module was unloaded
    }
  }
  await setView($, { phase: 'unavailable', notice: 'The dictation helper keeps stopping. Check that Node.js is on PATH, then run /reload-plugins.', noticeKind: 'error' })
}

// Takes the push-to-talk key for this session; one request, only when another
// session held it.
function claimKey($: Engine) {
  if (ownsKey || !control) return
  ownsKey = true
  void send($, 'activate').catch(() => {
    ownsKey = false
  })
}

// Opens the key file in Notepad; the helper watches it, so saving reconnects.
async function openKeyFile($: Engine): Promise<string> {
  const r = await send($, 'edit-key')
  if (!r.ok) return `Could not open the key file: ${r.error ?? 'unknown error'}. Its path is ${keyFile}.`
  await setView($, {
    notice: 'Notepad opened the key file. Replace everything in it with your OpenAI API key (it starts with sk-) and save; dictation reconnects by itself.',
    noticeKind: 'info',
  })
  return `Opened ${r.keyFile} in Notepad. Replace everything in it with your OpenAI API key (it starts with sk-), then save. Dictation reconnects as soon as the file is saved.`
}

async function runCommand($: Engine, v: DictationView, sub = ''): Promise<string> {
  if (sub === 'setup' || (!v.hasKey && sub === '')) {
    return [
      'Live dictation streams your voice to OpenAI (gpt-live-transcribe, about $0.017 per minute of audio).',
      'It needs an OpenAI API key (create one at https://platform.openai.com/api-keys), read from OPENAI_API_KEY or from:',
      `  ${keyFile || '%USERPROFILE%\\.claude\\push-to-talk-dictation\\openai-api-key'}`,
      'Run /dictate key (or click Set up dictation above the prompt): Notepad opens that file.',
      'Replace everything in it with your key, save, and dictation reconnects by itself.',
    ].join('\n')
  }
  if (!control) return 'Dictation is still starting; try again in a moment.'
  switch (sub) {
    case 'key':
      return openKeyFile($)
    case '': {
      await send($, 'toggle')
      return v.phase === 'listening' ? 'Finishing dictation.' : `Dictating. Run /dictate again${v.hotkey ? ` or tap ${v.hotkey}` : ''} to finish.`
    }
    case 'stop':
      await send($, 'stop')
      return 'Finishing dictation.'
    case 'cancel':
      await send($, 'cancel')
      return 'Dictation canceled.'
    case 'reconnect': {
      const r = await send($, 'reconnect')
      if (r.hasKey) {
        isCheckingKey = true
        await setView($, { hasKey: true, notice: 'Key found. Checking it with OpenAI…', noticeKind: 'info' })
        return 'Key found; checking it with OpenAI. A toast says when it is accepted.'
      }
      await setView($, { hasKey: false, notice: `${r.problem ?? 'No OpenAI API key yet.'} ${SETUP_HINT}`, noticeKind: 'error' })
      return `${r.problem ?? 'No OpenAI API key yet.'} Run /dictate key to open the key file.`
    }
    case 'devices': {
      const r = await send($, 'devices')
      const devices: string[] = r.devices ?? []
      return [
        'Microphones (set one with the Microphone option, by part of its name; empty uses the Windows default):',
        ...devices.map(d => `  - ${d}`),
      ].join('\n')
    }
    case 'status': {
      const r = await send($, 'status')
      return [
        `State: ${r.state}; model: ${r.model}; warm stream: ${r.spare}; API key: ${r.hasKey ? `found (${r.keySource})` : 'missing'}.`,
        `Push-to-talk: ${v.hotkey || 'none in this session'}; microphone: ${helperConfig.device || 'Windows default'}; languages: ${helperConfig.languages.join(', ') || 'auto'}; latency: ${helperConfig.delay}.`,
      ].join('\n')
    }
    default:
      return 'Usage: /dictate [key | setup | stop | cancel | status | devices | reconnect]'
  }
}

export const register: Register = (on, options) => {
  helperConfig = {
    hotkey: String(options.hotkey ?? 'right-ctrl'),
    device: String(options.microphone ?? ''),
    languages: list(options.languages ?? 'en'),
    keywords: list(options.vocabulary),
    prompt: PROMPT_CONTEXT,
    delay: String(options.latency ?? 'low'),
  }
  showIdleBar = options.showIdleBar !== false
  liveText = options.liveText === true
  control = null
  region = null
  listeningId = null
  finishing.clear()
  toClipboard.clear()

  // ---- events --------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A headless run (claude -p, a script) has no prompt box to dictate into.
    if (!e.isInteractive) return started
    await update($, view, () => IDLE)
    await $.command.register({
      name: 'dictate',
      description: 'Live dictation: start or finish. Also: key, setup, stop, cancel, status, devices, reconnect',
    })
    void runHelper($)
    return started
  })

  // Enter while the last words are still being finalized: wait for them (a
  // second or so at most) so what is sent is what was said.
  // The session you type in takes the push-to-talk key from the others.
  on('prompt.change', async ($, e, next) => {
    claimKey($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    claimKey($)
    const r = region
    if (!r || r.isDetached || e.text !== r.lastWritten) {
      if (r && e.text === r.lastWritten) region = null
      return next(e)
    }
    if (listeningId !== null) await send($, 'stop')
    for (let waited = 0; waited < 3000 && r.segments.some(s => !s.isFinal); waited += 50) {
      await $.clock.sleep(50)
    }
    const { text } = compose(r)
    r.isDetached = true
    if (region === r) region = null
    return next({ ...e, text })
  }).catch(($, e, next) => next(e)) // never hold a prompt back

  on('command.run', { command: 'dictate' }, async ($, e) => {
    const v = await read($, view)
    return { text: await runCommand($, v, e.args.trim().toLowerCase()) }
  })

  // ---- the band above the prompt --------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const v = await read($, view)
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    // The desktop draws SVG: there the band uses Claude's own mic glyphs and a
    // bar waveform; the terminal gets text stand-ins.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
    const key = v.hotkey

    const mic = (isLive: boolean) =>
      Svg ? (
        <Svg source={micSvg(isLive, isLive ? LIVE_COLOR : IDLE_COLOR)} alt={isLive ? 'Listening' : 'Microphone'} width={16} height={16} />
      ) : (
        <Text color={isLive ? 'claude' : undefined} dimColor={!isLive}>
          {isLive ? '●' : '🎙'}
        </Text>
      )

    const notice = v.notice ? (
      <Box gap={1}>
        <Text color={v.noticeKind === 'error' ? 'error' : v.noticeKind === 'warning' ? 'warning' : 'subtle'} wrap="wrap">
          {v.notice}
        </Text>
        <Button key="dismiss" label="Dismiss" plain dimColor onPress={() => setView($, { notice: null, noticeKind: null })} />
      </Box>
    ) : null

    // Listening: the native dictation toolbar's parts and words, Done and Cancel.
    if (v.phase === 'listening') {
      const hint =
        v.mode === 'hold' && key
          ? `Release ${key} to finish · Esc cancels`
          : key
            ? `Tap ${key} or click Done to finish · Esc cancels`
            : 'Click Done to finish · Esc cancels'
      const tail = v.text.length > e.props.bodyColumns * 2 ? `…${v.text.slice(-(e.props.bodyColumns * 2 - 1))}` : v.text
      return (
        <Box flexDirection="column">
          <Box gap={1} alignItems="center">
            {mic(true)}
            <Text bold>Listening…</Text>
            {Svg ? (
              <Svg source={waveSvg(v.levels, LIVE_COLOR)} alt="Input level" height={16} />
            ) : (
              <Text color="claude">{wave(v.levels)}</Text>
            )}
            <Text dimColor tabular>
              {mmss(v.elapsedMs)}
            </Text>
            <Button key="done" label="Done" variant="primary" onPress={() => send($, 'stop')} />
            <Button key="cancel" label="Cancel" onPress={() => send($, 'cancel')} />
          </Box>
          {liveText && !v.isBoxLive && tail ? <Text wrap="wrap">{tail}</Text> : null}
          <Text dimColor>{hint}</Text>
          {notice}
        </Box>
      )
    }

    if (v.phase === 'finishing') {
      return (
        <Box flexDirection="column">
          <Box gap={1} alignItems="center">
            {mic(false)}
            <Text dimColor>Finishing dictation…</Text>
          </Box>
          {notice}
        </Box>
      )
    }

    if (v.phase === 'starting' || (!showIdleBar && !v.notice)) return next(e)

    if (v.phase === 'unavailable') return notice ?? next(e)

    return (
      <Box flexDirection="column">
        <Box gap={1} alignItems="center">
          {mic(false)}
          <Button
            key="dictate"
            label={v.hasKey ? 'Dictate' : 'Set up dictation'}
            plain
            onPress={async () => {
              if (!v.hasKey) {
                await openKeyFile($)
                return
              }
              await send($, 'start')
            }}
          />
          {v.hasKey && key && v.isOwner ? <Text dimColor>or press and hold {key} to record</Text> : null}
          {v.hasKey && key && !v.isOwner ? <Text dimColor>{key} is with another session; type here to bring it back</Text> : null}
        </Box>
        {notice}
      </Box>
    )
  })
}
