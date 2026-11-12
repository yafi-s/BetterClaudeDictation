// BetterClaudeDiction helper: the streaming half of the mod.
//
// The mod starts this once per session. It drives VoiceKit (native mic +
// global push-to-talk key), streams PCM16 to OpenAI's realtime transcription
// over a WebSocket opened ahead of time, and prints one JSON event per line on
// stdout for the mod: ready, state, level, transcript, final, error.
// The mod sends commands back over a localhost HTTP port with a token.
//
// The OpenAI key is read here, from OPENAI_API_KEY or from
// ~/.claude/push-to-talk-dictation/openai-api-key, and never printed or sent to the mod.

import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SAMPLE_RATE = 24000
const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000
const KEY_FILE = path.join(os.homedir(), '.claude', 'push-to-talk-dictation', 'openai-api-key')
const OWNER_FILE = path.join(os.homedir(), '.claude', 'push-to-talk-dictation', 'owner.json')
const SPARE_IDLE_MS = 10 * 60 * 1000

const HOTKEYS = {
  'right-ctrl': { vk: 0xa3, label: 'Right Ctrl' },
  'right-alt': { vk: 0xa5, label: 'Right Alt' },
  f8: { vk: 0x77, label: 'F8' },
  f9: { vk: 0x78, label: 'F9' },
  'scroll-lock': { vk: 0x91, label: 'Scroll Lock' },
  pause: { vk: 0x13, label: 'Pause' },
  off: { vk: 0, label: '' },
}

// ---- config ----------------------------------------------------------------

const config = (() => {
  // From the mod, as JSON in LIVE_DICTATION_CONFIG (no Windows argv quoting to
  // get wrong); `--config <json>` for running it by hand.
  const i = process.argv.indexOf('--config')
  const raw = i >= 0 ? process.argv[i + 1] : process.env.LIVE_DICTATION_CONFIG
  const given = raw ? JSON.parse(raw) : {}
  return {
    hotkey: 'right-ctrl',
    device: '',
    languages: ['en'],
    keywords: [],
    prompt: '',
    delay: 'low',
    holdMs: 300,
    warmConnection: true,
    maxMinutes: 5,
    wsUrl: process.env.LIVE_DICTATION_WS_URL || 'wss://api.openai.com/v1/realtime?intent=transcription',
    ...given,
  }
})()

const hotkey = HOTKEYS[config.hotkey] ?? HOTKEYS['right-ctrl']

// ---- output ----------------------------------------------------------------

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n')
}

const now = () => performance.now()

// The key, or why there is none. The file's text is never echoed anywhere:
// a problem is described by its shape alone.
//
// Where it looks, in order: OPENAI_API_KEY; the key file; then any other
// environment variable named like an OpenAI key (OPENAI_KEY, OPENAI_IMAGE_KEY):
// an OpenAI key is not tied to a model, so one made for images works here.
// `source` names where it came from, never what it is.
function keyStatus() {
  const fromEnv = process.env.OPENAI_API_KEY?.trim()
  if (fromEnv) return isKeyShaped(fromEnv) ? { key: fromEnv, source: 'OPENAI_API_KEY' } : { key: null, problem: 'OPENAI_API_KEY is set but does not look like an OpenAI API key (they start with sk-).' }
  const fromFile = keyFileStatus()
  if (fromFile.key) return fromFile
  for (const name of Object.keys(process.env)) {
    if (!/^openai.*key$/i.test(name) || /^openai_api_key$/i.test(name)) continue
    const value = process.env[name]?.trim().replace(/^['"]|['"]$/g, '')
    if (value && isKeyShaped(value)) return { key: value, source: name }
  }
  return fromFile
}

function keyFileStatus() {
  let raw
  try {
    raw = readFileSync(KEY_FILE, 'utf8')
  } catch {
    return { key: null, problem: 'No OpenAI API key yet.' }
  }
  const line = raw
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .find(Boolean)
  if (!line) return { key: null, problem: 'The key file is empty.' }
  const value = line.replace(/^OPENAI_API_KEY\s*=\s*/i, '').replace(/^['"]|['"]$/g, '').trim()
  if (isKeyShaped(value)) return { key: value, source: 'key file' }
  if (/[a-z]:[\\/]|^&\s*['"]/i.test(line)) return { key: null, problem: 'The key file holds a file path, not an API key.' }
  return { key: null, problem: 'The key file does not hold an OpenAI API key (they start with sk-).' }
}

function isKeyShaped(value) {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(value)
}

function readKey() {
  return keyStatus().key
}

// ---- which session owns the push-to-talk key ---------------------------------
//
// Every open session runs a helper that sees the key; owner.json names the one
// that answers it: the session typed in, sent from, or dictated in last. A new
// session takes it only when nobody holds it, and a press while the owner is
// gone (its session closed) goes to whichever helper claims it first.

function readOwner() {
  try {
    return JSON.parse(readFileSync(OWNER_FILE, 'utf8'))
  } catch {
    return null
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

function isOwner() {
  return readOwner()?.pid === process.pid
}

function claimOwner() {
  try {
    mkdirSync(path.dirname(OWNER_FILE), { recursive: true })
    writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }))
  } catch {}
  publishOwner()
}

function claimIfUnowned() {
  const owner = readOwner()
  if (owner?.pid === process.pid) return true
  if (owner && isAlive(owner.pid)) return false
  try {
    mkdirSync(path.dirname(OWNER_FILE), { recursive: true })
    // Remove a dead owner's file only if it still names that owner, then
    // create ours exclusively: of several helpers racing, one wins.
    if (owner && readOwner()?.pid === owner.pid) unlinkSync(OWNER_FILE)
    writeFileSync(OWNER_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: 'wx' })
  } catch {}
  publishOwner()
  return isOwner()
}

let wasOwner = null
function publishOwner(force = false) {
  const owns = isOwner()
  if (owns === wasOwner && !force) return
  wasOwner = owns
  emit({ type: 'owner', isOwner: owns })
}

// Saving the key file (from any editor, or a script) reconnects by itself.
function watchKeyFile() {
  const dir = path.dirname(KEY_FILE)
  const name = path.basename(KEY_FILE).toLowerCase()
  let timer = null
  try {
    mkdirSync(dir, { recursive: true })
    watch(dir, (_event, file) => {
      const changed = file?.toLowerCase()
      if (!changed || changed === path.basename(OWNER_FILE)) publishOwner()
      if (changed !== name) return
      clearTimeout(timer)
      timer = setTimeout(onKeyFileChanged, 300)
    })
  } catch (err) {
    emit({ type: 'debug', message: `Not watching the key file: ${err.message}` })
  }
}

function onKeyFileChanged() {
  const { key, problem } = keyStatus()
  emit({ type: 'key-updated', hasKey: Boolean(key), problem: problem ?? null })
  if (key && !current) {
    closeStream(spare)
    spare = null
    refillSpare()
  }
}

function openKeyFile() {
  mkdirSync(path.dirname(KEY_FILE), { recursive: true })
  if (!existsSync(KEY_FILE)) writeFileSync(KEY_FILE, '')
  // No windowsHide: Notepad is a window the person uses.
  spawn('notepad.exe', [KEY_FILE], { detached: true, stdio: 'ignore' }).unref()
}

// ---- native (mic + key) ----------------------------------------------------
//
// One capture at a time. Every `start` sent queues its owner; VoiceKit answers
// each with `started` ... audio ... `stopped` in order, so frames go to the
// dictation whose capture is open, even when the next press comes while the
// last one is still being finalized.

const exe = path.join(ROOT, 'native', 'voicekit.exe')

// The exe is built from VoiceKit.cs with the C# compiler every Windows has.
function ensureNativeBuilt() {
  if (existsSync(exe)) return
  const windir = process.env.WINDIR || 'C:\Windows'
  const csc = path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  execFileSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${exe}`, path.join(ROOT, 'native', 'VoiceKit.cs')], { windowsHide: true })
  emit({ type: 'debug', message: 'Built native/voicekit.exe from VoiceKit.cs.' })
}
let native = null
let shuttingDown = false
const captureQueue = []
let captureOwner = null // { d } or { d: null } for the warm-up open

function startNative(vk) {
  const argv = ['--hotkey', String(vk)]
  if (config.device) argv.push('--device', config.device)
  const child = spawn(exe, argv, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  native = child
  let buf = Buffer.alloc(0)
  child.stdout.on('data', chunk => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
    while (buf.length >= 5) {
      const len = buf.readUInt32LE(1)
      if (buf.length < 5 + len) break
      const type = buf[0]
      const payload = buf.subarray(5, 5 + len)
      buf = buf.subarray(5 + len)
      if (type === 1) captureOwner?.d && onAudio(captureOwner.d, Buffer.from(payload))
      else if (type === 2) onNative(JSON.parse(payload.toString('utf8')))
    }
  })
  child.stderr.on('data', d => emit({ type: 'debug', message: `voicekit: ${String(d).trim()}` }))
  child.on('error', err => emit({ type: 'error', message: `Could not start the microphone helper: ${err.message}` }))
  child.on('exit', code => {
    if (native === child) native = null
    if (shuttingDown) return
    emit({ type: 'warning', message: `Microphone helper exited (${code}); restarting.` })
    for (const owner of [captureOwner, ...captureQueue]) owner?.onStopped?.()
    captureOwner = null
    captureQueue.length = 0
    if (current) cancel(current, 'mic-helper-exit')
    setTimeout(() => startNative(vk), 1000)
  })
}

function openCapture(d) {
  const owner = { d, stopped: false, onStopped: null }
  captureQueue.push(owner)
  native?.stdin.write('start\n')
  return owner
}

function closeCapture(owner) {
  return new Promise(resolve => {
    if (owner.stopped) return resolve()
    const timer = setTimeout(resolve, 1000)
    owner.onStopped = () => {
      clearTimeout(timer)
      resolve()
    }
    native?.stdin.write('stop\n')
  })
}

function onNative(ev) {
  if (ev.type === 'key') return onKey(ev.state)
  if (ev.type === 'capture') {
    if (ev.state === 'started') {
      captureOwner = captureQueue.shift() ?? null
      if (captureOwner?.d) emit({ type: 'mic', state: 'open', id: captureOwner.d.id, device: ev.device, openMs: ev.openMs })
    } else if (ev.state === 'stopped') {
      const owner = captureOwner ?? captureQueue.shift()
      captureOwner = null
      if (owner) {
        owner.stopped = true
        owner.onStopped?.()
      }
    } else if (ev.state === 'error') {
      emit({ type: 'error', message: ev.message })
      const owner = captureQueue[0]
      if (owner?.d && owner.d === current) cancel(owner.d, 'mic-error', { quiet: true })
    }
    return
  }
  if (ev.type === 'warning') emit({ type: 'warning', message: ev.message })
}

// ---- gestures ---------------------------------------------------------------
//
// Hold the key and talk, release to insert (push-to-talk). A quick tap locks
// dictation on hands-free; tap again to insert. Escape cancels. Pressing the
// key as part of a shortcut (another key within the first 600 ms) cancels
// silently, so Right Ctrl+C still just copies.

let keyDownAt = 0
let lockedTapPending = false
let pressIsElsewhere = false // this press belongs to another session's helper

function onKey(state) {
  const t = now()
  const d = current
  if (pressIsElsewhere) {
    if (state === 'up') pressIsElsewhere = false
    return
  }
  if (state === 'down') {
    keyDownAt = t
    if (!d) {
      // Every open session sees the key; only the owner's helper answers it.
      if (!claimIfUnowned()) {
        pressIsElsewhere = true
        return
      }
      start('hotkey', 'hold')
    } else if (d.mode === 'locked') lockedTapPending = true
  } else if (state === 'up') {
    if (d && d.mode === 'hold' && d.source === 'hotkey') {
      if (t - keyDownAt < config.holdMs) {
        d.mode = 'locked'
        publishState()
      } else {
        finish(d, 'release')
      }
    } else if (lockedTapPending) {
      lockedTapPending = false
      if (d) finish(d, 'tap')
    }
  } else if (state === 'chord') {
    if (lockedTapPending) lockedTapPending = false // a shortcut while locked: keep listening
    else if (d && d.mode === 'hold' && t - keyDownAt < 600) cancel(d, 'shortcut', { quiet: true })
  } else if (state === 'escape') {
    if (d) cancel(d, 'escape')
  }
}

// ---- OpenAI realtime transcription streams -----------------------------------
//
// Each dictation has its own stream, so a late transcript can never land in
// the next one. A spare stream is opened ahead of time and handed to the next
// dictation, which therefore starts on a configured, ready connection.

let spare = null
let spareFailures = 0 // consecutive spare streams that never opened
let spareTimer = null

function sessionUpdate(level) {
  const transcription = { model: 'gpt-live-transcribe' }
  if (level <= 2 && config.languages.length) transcription.languages = config.languages
  if (level <= 1) {
    if (config.prompt) transcription.prompt = config.prompt
    const keywords = config.keywords.map(k => String(k).replace(/[<>\r\n]/g, ' ').trim()).filter(Boolean)
    if (keywords.length) transcription.keywords = keywords
  }
  if (level === 0 && config.delay) transcription.delay = config.delay
  if (level >= 3) {
    // Last resort: the older streaming model, deprecated but still served.
    delete transcription.languages
    transcription.model = 'gpt-4o-transcribe'
    if (config.languages[0]) transcription.language = config.languages[0]
    if (config.prompt) transcription.prompt = config.prompt
  }
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: SAMPLE_RATE },
          transcription,
          turn_detection: null,
          noise_reduction: { type: 'near_field' },
        },
      },
    },
  }
}

// The settings level that worked last; later streams start there.
let settingsLevel = 0

function openStream() {
  const key = readKey()
  if (!key) return null
  const openedAt = now()
  const ws = new WebSocket(config.wsUrl, { headers: { Authorization: `Bearer ${key}` } })
  const s = { ws, ready: false, level: settingsLevel, queue: [], owner: null, closedOnPurpose: false, failed: false }

  const configure = () => ws.send(JSON.stringify(sessionUpdate(s.level)))
  ws.addEventListener('open', configure)
  ws.addEventListener('message', ({ data }) => {
    let ev
    try {
      ev = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
    } catch {
      return
    }
    if (ev.type === 'session.updated' || ev.type === 'transcription_session.updated') {
      if (!s.ready) {
        s.ready = true
        spareFailures = 0
        settingsLevel = s.level
        emit({ type: 'stream', state: 'ready', ms: Math.round(now() - openedAt), model: s.level >= 3 ? 'gpt-4o-transcribe' : 'gpt-live-transcribe', settingsLevel: s.level })
        for (const m of s.queue) ws.send(m)
        s.queue = []
      }
      return
    }
    if (ev.type === 'error') {
      const message = ev.error?.message ?? 'unknown error'
      const code = ev.error?.code ?? ''
      const isAuth = /auth|api key|api_key|quota|billing|permission|insufficient/i.test(`${message} ${code}`)
      if (!s.ready && s.level < 3 && !isAuth) {
        s.level += 1
        emit({ type: 'warning', message: `OpenAI refused part of the session settings (${message}); retrying with fewer.` })
        configure()
        return
      }
      if (/commit_empty|buffer too small|buffer is empty/i.test(`${message} ${code}`)) {
        if (s.owner) {
          s.owner.commitsAcked += 1
          maybeDone(s.owner)
        }
        return
      }
      const isBadKey = /incorrect api key|invalid_api_key|invalid api key|invalid authentication/i.test(`${message} ${code}`)
      emit({
        type: 'error',
        // OpenAI's own text echoes part of the key; say what to do instead.
        message: isBadKey
          ? 'OpenAI rejected the API key. Click Set up dictation (or run /dictate key), paste a key that starts with sk-, and save.'
          : `OpenAI: ${message}`,
        isAuth,
      })
      if (!s.ready) {
        s.failed = true
        ws.close()
      }
      return
    }
    if (s.owner) onServerEvent(s.owner, ev)
  })
  ws.addEventListener('close', ({ code, reason }) => {
    if (spare === s) spare = null
    const d = s.owner
    if (s.closedOnPurpose) return
    const why = `${code}${reason ? `: ${reason}` : ''}`
    if (!s.ready && !s.failed) {
      // It never opened: usually a network blip (1006), so try again quietly.
      if (!d) {
        spareFailures += 1
        if (spareFailures <= 3) setTimeout(refillSpare, 1000 * spareFailures)
        else emit({ type: 'error', message: `Could not reach OpenAI's transcription service (${why}).` })
        return
      }
      if (d.phase !== 'canceled' && d.phase !== 'done' && (d.reopens ?? 0) < 2) {
        d.reopens = (d.reopens ?? 0) + 1
        const next = openStream()
        if (next) {
          next.queue.push(...s.queue) // the audio captured so far goes out on the new stream
          next.owner = d
          d.stream = next
          return
        }
      }
      emit({ type: 'error', message: `Could not reach OpenAI's transcription service (${why}).` })
      if (d.phase === 'listening') cancel(d, 'stream', { quiet: true })
      else if (d.phase === 'finishing') settle(d)
      return
    }
    if (!d) return
    if (d.phase === 'finishing') settle(d)
    else if (d.phase === 'listening') {
      if (!s.ready) cancel(d, 'stream', { quiet: true })
      else {
        emit({ type: 'warning', message: 'Transcription stream dropped; reconnecting.' })
        const next = openStream()
        if (next) {
          next.owner = d
          d.stream = next
        } else cancel(d, 'stream', { quiet: true })
      }
    }
  })
  ws.addEventListener('error', () => {})
  return s
}

function refillSpare() {
  clearTimeout(spareTimer)
  if (!config.warmConnection || shuttingDown) return
  if (!spare) spare = openStream()
  spareTimer = setTimeout(() => {
    if (spare && !spare.owner) closeStream(spare)
    spare = null
  }, SPARE_IDLE_MS)
}

function takeStream() {
  let s = spare
  spare = null
  if (!s || s.ws.readyState > WebSocket.OPEN) s = openStream()
  setTimeout(refillSpare, 400)
  return s
}

function streamSend(d, obj) {
  const s = d.stream
  if (!s) return
  const m = JSON.stringify(obj)
  if (s.ready && s.ws.readyState === WebSocket.OPEN) s.ws.send(m)
  else s.queue.push(m)
}

function closeStream(s) {
  if (!s) return
  s.closedOnPurpose = true
  try {
    s.ws.close()
  } catch {}
}

// ---- dictation ---------------------------------------------------------------

let current = null // the dictation listening now
let nextId = 1

function start(source, mode) {
  if (current) return
  const stream = takeStream()
  if (!stream) {
    emit({ type: 'needs-key', keyFile: KEY_FILE, problem: keyStatus().problem ?? null })
    return
  }
  const d = {
    id: nextId++,
    source,
    mode,
    phase: 'listening',
    startedAt: now(),
    stream,
    items: new Map(),
    pendingBytes: [],
    pendingLen: 0,
    hasSignal: false,
    speechInSegment: 0,
    silenceRun: 0,
    segmentMs: 0,
    uncommittedMs: 0,
    commitsSent: 0,
    commitsAcked: 0,
    lastLevelAt: 0,
    floor: 0,
    peak: 0,
    lastText: '',
    lastStable: 0,
  }
  stream.owner = d
  current = d
  lockedTapPending = false
  d.capture = openCapture(d)
  d.maxTimer = setTimeout(() => finish(d, 'max-duration'), config.maxMinutes * 60 * 1000)
  publishState()
}

function rmsOf(pcm) {
  let sum = 0
  const n = pcm.length >> 1
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2)
    sum += v * v
  }
  return n ? Math.sqrt(sum / n) : 0
}

function onAudio(d, pcm) {
  if (d.phase === 'canceled' || d.phase === 'done') return
  const ms = pcm.length / BYTES_PER_MS
  const rms = rmsOf(pcm)

  // The noise floor follows quickly down and slowly up; speech stands well above it.
  d.floor = d.floor === 0 ? rms : rms < d.floor ? rms : d.floor + (rms - d.floor) * 0.002
  const isSpeech = rms > Math.max(350, d.floor * 2.5)
  if (rms >= 120) d.hasSignal = true
  d.peak = Math.max(d.peak * 0.85, rms)

  if (isSpeech) {
    d.speechInSegment += ms
    d.silenceRun = 0
  } else {
    d.silenceRun += ms
  }
  d.segmentMs += ms
  d.uncommittedMs += ms

  d.pendingBytes.push(pcm)
  d.pendingLen += pcm.length
  if (d.pendingLen >= 60 * BYTES_PER_MS) flushAudio(d)

  // gpt-live-transcribe takes no server VAD, so turns end here: at a natural
  // pause, or at a ceiling, so long dictations finalize as they go.
  if (d.phase === 'listening' && d.speechInSegment >= 300 && (d.silenceRun >= 800 || d.segmentMs >= 25000)) {
    commit(d)
  }

  const t = now()
  if (d.phase === 'listening' && t - d.lastLevelAt >= 66) {
    d.lastLevelAt = t
    emit({ type: 'level', id: d.id, level: Math.min(1, Math.sqrt(d.peak / 6000)), elapsedMs: Math.round(t - d.startedAt) })
  }
}

function flushAudio(d) {
  if (d.pendingLen === 0) return
  const audio = Buffer.concat(d.pendingBytes, d.pendingLen).toString('base64')
  d.pendingBytes = []
  d.pendingLen = 0
  streamSend(d, { type: 'input_audio_buffer.append', audio })
}

function commit(d) {
  flushAudio(d)
  streamSend(d, { type: 'input_audio_buffer.commit' })
  d.commitsSent += 1
  d.speechInSegment = 0
  d.segmentMs = 0
  d.uncommittedMs = 0
}

async function finish(d, reason) {
  if (d.phase !== 'listening') return
  d.phase = 'finishing'
  d.finishReason = reason
  clearTimeout(d.maxTimer)
  if (current === d) current = null
  lockedTapPending = false
  publishState(d)
  await closeCapture(d.capture)
  if (d.phase !== 'finishing') return
  if (d.hasSignal && d.uncommittedMs >= 100) {
    // A quarter second of silence lets the model close the last word, as Codex does.
    d.pendingBytes.push(Buffer.alloc(250 * BYTES_PER_MS))
    d.pendingLen += 250 * BYTES_PER_MS
    commit(d)
  }
  d.settleTimer = setTimeout(() => settle(d), 5000)
  maybeDone(d)
}

function cancel(d, reason, { quiet = false } = {}) {
  if (d.phase === 'canceled' || d.phase === 'done') return
  d.phase = 'canceled'
  clearTimeout(d.maxTimer)
  clearTimeout(d.settleTimer)
  if (current === d) current = null
  if (!d.capture.stopped) closeCapture(d.capture)
  closeStream(d.stream)
  emit({ type: 'canceled', id: d.id, reason, quiet })
  publishState(d)
}

function itemOf(d, id) {
  if (!id || d.phase === 'canceled' || d.phase === 'done') return null
  let it = d.items.get(id)
  if (!it) {
    it = { order: d.items.size, partial: '', final: null }
    d.items.set(id, it)
  }
  return it
}

function onServerEvent(d, ev) {
  switch (ev.type) {
    case 'input_audio_buffer.committed':
      itemOf(d, ev.item_id)
      d.commitsAcked += 1
      break
    case 'conversation.item.input_audio_transcription.delta': {
      const it = itemOf(d, ev.item_id)
      if (!it || it.final !== null) return
      it.partial += ev.delta ?? ''
      publishTranscript(d)
      break
    }
    case 'conversation.item.input_audio_transcription.completed': {
      const it = itemOf(d, ev.item_id)
      if (!it) return
      it.final = ev.transcript ?? it.partial
      publishTranscript(d)
      break
    }
    case 'conversation.item.input_audio_transcription.failed': {
      const it = itemOf(d, ev.item_id)
      if (!it) return
      it.final = it.partial
      emit({ type: 'warning', message: `A segment failed to transcribe: ${ev.error?.message ?? 'unknown error'}` })
      publishTranscript(d)
      break
    }
  }
  maybeDone(d)
}

function texts(d) {
  const list = [...d.items.values()].sort((a, b) => a.order - b.order)
  let text = ''
  let stable = 0
  let isStable = true
  for (const it of list) {
    const piece = (it.final ?? it.partial).trim()
    if (!piece) continue
    text = text ? `${text} ${piece}` : piece
    if (isStable && it.final !== null) stable = text.length
    else isStable = false
  }
  return { text, stable }
}

function publishTranscript(d) {
  const { text, stable } = texts(d)
  if (text === d.lastText && stable === d.lastStable) return
  d.lastText = text
  d.lastStable = stable
  emit({ type: 'transcript', id: d.id, text, stable })
}

function maybeDone(d) {
  if (d.phase !== 'finishing' || !d.capture.stopped) return
  const pending = [...d.items.values()].some(it => it.final === null)
  if (d.commitsAcked >= d.commitsSent && !pending) settle(d)
}

function settle(d) {
  if (d.phase !== 'finishing') return
  d.phase = 'done'
  clearTimeout(d.settleTimer)
  closeStream(d.stream)
  const { text } = texts(d)
  emit({
    type: 'final',
    id: d.id,
    text,
    isSilent: !d.hasSignal,
    reason: d.finishReason,
    ms: Math.round(now() - d.startedAt),
  })
  publishState(d)
}

function publishState(d = current) {
  emit({
    type: 'state',
    id: d?.id ?? null,
    state: current ? current.phase : 'idle',
    mode: current?.mode ?? null,
    source: current?.source ?? null,
    phase: d?.phase ?? null,
  })
}

// ---- control port -------------------------------------------------------------

const token = randomBytes(16).toString('hex')

const server = http.createServer((req, res) => {
  if (req.headers['x-token'] !== token) {
    res.writeHead(403).end()
    return
  }
  const cmd = new URL(req.url, 'http://x').searchParams.get('c')
  const reply = body => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  switch (cmd) {
    case 'toggle':
      claimOwner()
      if (current) finish(current, 'command')
      else start('command', 'locked')
      return reply({ ok: true })
    case 'start':
      claimOwner()
      start('command', 'locked')
      return reply({ ok: true })
    case 'activate':
      claimOwner()
      return reply({ ok: true, isOwner: true })
    case 'stop':
      if (current) finish(current, 'command')
      return reply({ ok: true })
    case 'cancel':
      if (current) cancel(current, 'command')
      return reply({ ok: true })
    case 'devices': {
      const p = spawn(exe, ['--list-devices'], { windowsHide: true })
      let out = ''
      p.stdout.on('data', d => (out += d))
      p.on('close', () => reply({ ok: true, devices: JSON.parse(out || '[]') }))
      return
    }
    case 'status':
      return reply({
        ok: true,
        state: current?.phase ?? 'idle',
        hasKey: Boolean(readKey()),
        keySource: keyStatus().source ?? null,
        spare: spare ? (spare.ready ? 'ready' : 'connecting') : 'none',
        model: settingsLevel >= 3 ? 'gpt-4o-transcribe' : 'gpt-live-transcribe',
        settingsLevel,
      })
    case 'reconnect': {
      closeStream(spare)
      spare = null
      refillSpare()
      const { key, problem } = keyStatus()
      return reply({ ok: true, hasKey: Boolean(key), problem: problem ?? null })
    }
    case 'edit-key':
      try {
        openKeyFile()
        return reply({ ok: true, keyFile: KEY_FILE })
      } catch (err) {
        return reply({ ok: false, error: err.message })
      }
    case 'quit':
      reply({ ok: true })
      return shutdown()
    default:
      return reply({ ok: false, error: `unknown command ${cmd}` })
  }
})

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  if (isOwner()) {
    try {
      unlinkSync(OWNER_FILE)
    } catch {}
  }
  if (current) cancel(current, 'shutdown', { quiet: true })
  closeStream(spare)
  try {
    native?.stdin.end('quit\n')
  } catch {}
  setTimeout(() => process.exit(0), 300)
}

// Leave with the session: the parent is the Claude Code process.
const parent = process.ppid
setInterval(() => {
  try {
    process.kill(parent, 0)
  } catch {
    shutdown()
  }
}, 5000).unref()

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

try {
  ensureNativeBuilt()
} catch (err) {
  emit({ type: 'error', message: `Could not build the microphone helper (native/voicekit.exe): ${err.message}` })
}
// Every session's helper watches the key; the owner file says which one acts.
startNative(hotkey.vk)
claimIfUnowned()
server.listen(0, '127.0.0.1', () => {
  emit({
    type: 'ready',
    port: server.address().port,
    token,
    hasKey: Boolean(readKey()),
    keyProblem: keyStatus().problem ?? null,
    keySource: keyStatus().source ?? null,
    keyFile: KEY_FILE,
    hotkey: hotkey.label,
  })
  publishOwner(true)
  // Warm path, as Codex prepares its audio graph ahead of the press: open the
  // mic driver once (a process's first open costs ~100 ms, later ones ~8 ms)
  // and a configured transcription stream.
  setTimeout(() => {
    if (!current && native) {
      const warm = openCapture(null)
      closeCapture(warm)
    }
  }, 200)
  refillSpare()
  watchKeyFile()
})
