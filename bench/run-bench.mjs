// Measures what the mod is built for, on the same audio for every setup:
//
//   mod        gpt-live-transcribe streamed while you talk, with the mod's
//              prompt and vocabulary hints (what ships)
//   no-hints   the same stream without the prompt and vocabulary
//   upload     record first, then upload the whole clip on release
//              (/v1/audio/transcriptions), the usual way dictation tools work
//
// For each: time to the first word (streaming only), time from release to the
// final text, and word error rate against the sentence that was spoken.
//
//   powershell -File bench/make-speech.ps1     (once: speaks sentences.txt)
//   node bench/mic-open.mjs                    (optional: mic open times)
//   node bench/run-bench.mjs                   (writes RESULTS.md, results.json)
//
// Needs an OpenAI key, found as the mod finds it. Costs about $0.05 a run.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const WS_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
const UPLOAD_URL = 'https://api.openai.com/v1/audio/transcriptions'
const UPLOAD_MODELS = ['gpt-transcribe', 'gpt-4o-mini-transcribe']
const BYTES_PER_MS = 48
const CHUNK_MS = 60

// The settings the mod ships with, read from its own files.
const manifest = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'))
const VOCABULARY = manifest.userConfig.vocabulary.default.split(',').map(s => s.trim()).filter(Boolean)
const PROMPT = /const PROMPT_CONTEXT =\s*'([^']+)'/.exec(readFileSync(path.join(ROOT, 'hooks', 'register.tsx'), 'utf8'))[1]
const DELAY = manifest.userConfig.latency.default

function findKey() {
  if (process.env.OPENAI_API_KEY?.trim()) return process.env.OPENAI_API_KEY.trim()
  try {
    const line = readFileSync(path.join(os.homedir(), '.claude', 'push-to-talk-dictation', 'openai-api-key'), 'utf8').trim().split(/\r?\n/)[0]
    if (/^sk-[A-Za-z0-9_-]{20,}$/.test(line)) return line
  } catch {}
  for (const [name, value] of Object.entries(process.env)) {
    if (/^openai.*key$/i.test(name) && /^sk-[A-Za-z0-9_-]{20,}$/.test(value?.trim() ?? '')) return value.trim()
  }
  throw new Error('No OpenAI API key found (OPENAI_API_KEY, the key file, or an OpenAI*Key variable).')
}

const REPORT_ONLY = process.argv.includes('--report')
const LONG_ONLY = process.argv.includes('--long-only')
const KEY = REPORT_ONLY ? '' : findKey()
const now = () => performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))

function pcmOf(wav) {
  const at = wav.indexOf('data')
  return wav.subarray(at + 8, at + 8 + wav.readUInt32LE(at + 4))
}

function words(s) {
  return s
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[-_/]/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

// Streams the clip in real time, as the mod does from the mic, then appends
// 250 ms of silence and commits at "release".
function stream(pcm, { hints }) {
  return new Promise((resolve, reject) => {
    const transcription = { model: 'gpt-live-transcribe', languages: ['en'], delay: DELAY }
    if (hints) Object.assign(transcription, { prompt: PROMPT, keywords: VOCABULARY })
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${KEY}` } })
    const t = { opened: now() }
    let first = null
    let released = null
    const timer = setTimeout(() => (ws.close(), reject(new Error('timed out'))), 45000)
    ws.addEventListener('open', () =>
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null, noise_reduction: { type: 'near_field' } } } } })),
    )
    ws.addEventListener('close', () => clearTimeout(timer))
    ws.addEventListener('message', async ({ data }) => {
      const ev = JSON.parse(data)
      if (ev.type === 'error') return (ws.close(), reject(new Error(ev.error?.message ?? 'error')))
      if (ev.type === 'session.updated' && !t.ready) {
        t.ready = now()
        t.start = now()
        const chunk = CHUNK_MS * BYTES_PER_MS
        for (let i = 0, o = 0; o < pcm.length; i++, o += chunk) {
          const due = t.start + i * CHUNK_MS
          if (due > now()) await sleep(due - now())
          ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.subarray(o, o + chunk).toString('base64') }))
        }
        released = now()
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.alloc(250 * BYTES_PER_MS).toString('base64') }))
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      } else if (ev.type === 'conversation.item.input_audio_transcription.delta') {
        if (first === null) first = now()
      } else if (ev.type === 'conversation.item.input_audio_transcription.completed') {
        const done = now()
        ws.close()
        resolve({ connectMs: t.ready - t.opened, firstWordMs: first === null ? null : first - t.start, finalMs: done - released, text: ev.transcript ?? '' })
      }
    })
  })
}

// A long dictation: every sentence in turn with a 900 ms pause between, the
// way the mod sends it: in real time, committing 800 ms into each pause, so
// all but the last sentence are final before "release".
function streamLong(pcms) {
  return new Promise((resolve, reject) => {
    const transcription = { model: 'gpt-live-transcribe', languages: ['en'], delay: DELAY, prompt: PROMPT, keywords: VOCABULARY }
    const ws = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${KEY}` } })
    const order = []
    const finals = new Map()
    let commits = 0
    let released = null
    const timer = setTimeout(() => (ws.close(), reject(new Error('timed out'))), 180000)
    const send = o => ws.send(JSON.stringify(o))
    const realtime = async (pcm, startAt) => {
      const chunk = CHUNK_MS * BYTES_PER_MS
      for (let i = 0, o = 0; o < pcm.length; i++, o += chunk) {
        const due = startAt + i * CHUNK_MS
        if (due > now()) await sleep(due - now())
        send({ type: 'input_audio_buffer.append', audio: pcm.subarray(o, o + chunk).toString('base64') })
      }
      return startAt + Math.ceil(pcm.length / chunk) * CHUNK_MS
    }
    ws.addEventListener('open', () =>
      send({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription, turn_detection: null, noise_reduction: { type: 'near_field' } } } } }),
    )
    ws.addEventListener('close', () => clearTimeout(timer))
    let started = false
    ws.addEventListener('message', async ({ data }) => {
      const ev = JSON.parse(data)
      if (ev.type === 'error') return (ws.close(), reject(new Error(ev.error?.message ?? 'error')))
      if (ev.type === 'session.updated' && !started) {
        started = true
        let at = now()
        for (const [i, pcm] of pcms.entries()) {
          at = await realtime(pcm, at)
          if (i === pcms.length - 1) break
          at = await realtime(Buffer.alloc(800 * BYTES_PER_MS), at)
          send({ type: 'input_audio_buffer.commit' })
          commits += 1
          at = await realtime(Buffer.alloc(100 * BYTES_PER_MS), at)
        }
        released = now()
        send({ type: 'input_audio_buffer.append', audio: Buffer.alloc(250 * BYTES_PER_MS).toString('base64') })
        send({ type: 'input_audio_buffer.commit' })
        commits += 1
      } else if (ev.type === 'input_audio_buffer.committed') {
        order.push(ev.item_id)
      } else if (ev.type === 'conversation.item.input_audio_transcription.completed') {
        finals.set(ev.item_id, ev.transcript ?? '')
        if (released !== null && finals.size >= commits) {
          const done = now()
          ws.close()
          resolve({ finalMs: done - released, text: order.map(id => finals.get(id) ?? '').join(' ') })
        }
      }
    })
  })
}

function wavOf(pcm) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(24000, 24)
  head.writeUInt32LE(48000, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

let uploadModel = null
async function upload(wav) {
  for (const model of uploadModel ? [uploadModel] : UPLOAD_MODELS) {
    const form = new FormData()
    form.append('model', model)
    form.append('language', 'en')
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
    const t0 = now()
    const r = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form })
    const body = await r.json()
    if (r.ok) {
      uploadModel = model
      return { finalMs: now() - t0, text: body.text ?? '' }
    }
    if (uploadModel) throw new Error(body.error?.message ?? r.status)
  }
  throw new Error('No upload model was accepted.')
}

// Vocabulary terms the sentence contains, and how many the transcript wrote
// exactly as spelled (case included): what the hints are for.
function termHits(ref, text) {
  let found = 0
  let exact = 0
  for (const term of VOCABULARY) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`)
    if (!re.test(ref)) continue
    if (term === 'Claude' && /Claude Code/.test(ref)) continue
    found += 1
    if (re.test(text)) exact += 1
  }
  return { found, exact }
}

const median = xs => {
  const s = xs.filter(x => x !== null).sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null
}
const p90 = xs => {
  const s = xs.filter(x => x !== null).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)] : null
}

// --report rebuilds RESULTS.md from results.json without calling the API.
const setups = ['mod', 'no-hints', 'upload']
const saved = REPORT_ONLY ? JSON.parse(readFileSync(path.join(HERE, 'results.json'), 'utf8')) : null
const rows = saved ? saved.rows : []
if (saved) uploadModel = saved.uploadModel
const audioDir = path.join(HERE, 'audio')
if (!REPORT_ONLY && !existsSync(audioDir)) throw new Error('Run bench/make-speech.ps1 first.')
const sentences = readFileSync(path.join(HERE, 'sentences.txt'), 'utf8').split(/\r?\n/).filter(s => s.trim())
const files = REPORT_ONLY || LONG_ONLY ? [] : readdirSync(audioDir).filter(f => f.endsWith('.wav')).sort()

for (const [i, file] of files.entries()) {
  const wav = readFileSync(path.join(audioDir, file))
  const pcm = pcmOf(wav)
  const ref = sentences[i]
  const row = { sentence: ref, audioMs: Math.round(pcm.length / BYTES_PER_MS) }
  for (const setup of setups) {
    const r = setup === 'upload' ? await upload(wav) : await stream(pcm, { hints: setup === 'mod' })
    const errors = editDistance(words(ref), words(r.text))
    row[setup] = { ...r, errors, words: words(ref).length }
    console.log(`${file} ${setup.padEnd(8)} final ${Math.round(r.finalMs)} ms  errors ${errors}  "${r.text}"`)
  }
  rows.push(row)
}

// The long dictation, unless only rebuilding the report. --long-only keeps the
// saved sentence rows and measures just this part.
let long = saved?.long ?? null
if (LONG_ONLY) {
  const prev = JSON.parse(readFileSync(path.join(HERE, 'results.json'), 'utf8'))
  rows.push(...prev.rows)
  uploadModel = prev.uploadModel
}
if (!REPORT_ONLY) {
  const pcms = readdirSync(audioDir).filter(f => f.endsWith('.wav')).sort().map(f => pcmOf(readFileSync(path.join(audioDir, f))))
  const pause = Buffer.alloc(900 * BYTES_PER_MS)
  const joined = Buffer.concat(pcms.flatMap((p, i) => (i < pcms.length - 1 ? [p, pause] : [p])))
  const ref = sentences.join(' ')
  const streamed = await streamLong(pcms)
  const uploaded = await upload(wavOf(joined))
  long = {
    audioMs: Math.round(joined.length / BYTES_PER_MS),
    words: words(ref).length,
    mod: { finalMs: streamed.finalMs, errors: editDistance(words(ref), words(streamed.text)), text: streamed.text },
    upload: { finalMs: uploaded.finalMs, errors: editDistance(words(ref), words(uploaded.text)), text: uploaded.text },
  }
  console.log(`long  mod    final ${Math.round(long.mod.finalMs)} ms  errors ${long.mod.errors}`)
  console.log(`long  upload final ${Math.round(long.upload.finalMs)} ms  errors ${long.upload.errors}`)
}

const summary = Object.fromEntries(
  setups.map(s => {
    const xs = rows.map(r => r[s])
    const errors = xs.reduce((a, x) => a + x.errors, 0)
    const total = xs.reduce((a, x) => a + x.words, 0)
    const terms = rows.map(r => termHits(r.sentence, r[s].text))
    return [
      s,
      {
        firstWordMs: median(xs.map(x => x.firstWordMs ?? null)),
        finalMedianMs: median(xs.map(x => x.finalMs)),
        finalP90Ms: p90(xs.map(x => x.finalMs)),
        wer: errors / total,
        errors,
        words: total,
        connectMs: median(xs.map(x => x.connectMs ?? null)),
        termsExact: terms.reduce((a, t) => a + t.exact, 0),
        termsFound: terms.reduce((a, t) => a + t.found, 0),
      },
    ]
  }),
)

const micPath = path.join(HERE, 'mic-open.json')
const mic = existsSync(micPath) ? JSON.parse(readFileSync(micPath, 'utf8')) : null
const runDate = saved?.date ?? new Date().toISOString()
const runNode = saved?.node ?? process.version
const keptLongRuns = REPORT_ONLY ? saved?.longRuns : long ? [...(LONG_ONLY ? JSON.parse(readFileSync(path.join(HERE, 'results.json'), 'utf8')).longRuns ?? [] : []), long] : undefined
writeFileSync(path.join(HERE, 'results.json'), JSON.stringify({ date: runDate, node: runNode, uploadModel, delay: DELAY, summary, long, longRuns: keptLongRuns, mic, rows }, null, 2))

const ms = x => (x === null ? 'n/a' : `${Math.round(x)} ms`)
const pct = x => `${(x * 100).toFixed(1)}%`
const label = { mod: 'This mod (streaming + hints)', 'no-hints': 'Streaming, no hints', upload: `Record, then upload (${uploadModel})` }
const md = [
  '# Benchmark results',
  '',
  `Run ${runDate.slice(0, 10)} on Windows, Node ${runNode}. ${rows.length} sentences of synthetic speech (Windows' built-in voice, 24 kHz), the same audio for every setup; streaming setups send it in real time. Latency includes the network round trip to OpenAI.`,
  '',
  '| Setup | First word ready (median) | Release → final text (median) | Release → final text (p90) | Word error rate | Tech terms written exactly |',
  '| --- | --- | --- | --- | --- | --- |',
  ...setups.map(s => `| ${label[s]} | ${s === 'upload' ? 'only at the end' : ms(summary[s].firstWordMs)} | ${ms(summary[s].finalMedianMs)} | ${ms(summary[s].finalP90Ms)} | ${pct(summary[s].wer)} (${summary[s].errors}/${summary[s].words} words) | ${summary[s].termsExact}/${summary[s].termsFound} |`),
  '',
  'Word error rate ignores case and punctuation. "Tech terms written exactly" counts the vocabulary terms in each sentence (README, Kubernetes, Claude Code, ...) that came back spelled and capitalized exactly. First word ready is counted from the start of the clip, which opens with a short silence.',
  '',
  `Opening a stream takes about ${ms(summary.mod.connectMs)}; the mod opens one ahead of time, so a press never waits for it.`,
  '',
]
const longRuns = saved?.longRuns ?? (long ? [long] : [])
if (longRuns.length) {
  const first = longRuns[0]
  md.push(
    '## A long dictation',
    '',
    `All ${rows.length} sentences as one ${Math.round(first.audioMs / 1000)}-second dictation, with a 900 ms pause between sentences. The mod streams it and finalizes each sentence at its pause, so on release only the last sentence is left; the upload sends and transcribes the whole clip after release.`,
    '',
    '| Run | This mod: release → full text | Record, then upload: release → full text | Word errors (mod / upload) |',
    '| --- | --- | --- | --- |',
    ...longRuns.map((r, i) => `| ${i + 1} | ${ms(r.mod.finalMs)} | ${ms(r.upload.finalMs)} | ${r.mod.errors}/${r.words} / ${r.upload.errors}/${r.words} |`),
    `| Median | ${ms(median(longRuns.map(r => r.mod.finalMs)))} | ${ms(median(longRuns.map(r => r.upload.finalMs)))} | |`,
    '',
  )
}
if (mic) {
  md.push('## Opening the microphone', '', '| Capture path | First audio after the press (median) | Runs |', '| --- | --- | --- |')
  for (const m of mic.results) md.push(`| ${m.label} | ${ms(m.medianMs)} | ${m.runs.map(x => Math.round(x)).join(', ')} ms |`)
  md.push('', 'Audio that arrives before the mic opens is lost, so this is how much of your first word a press can clip.', '')
}
md.push('## Per sentence', '', '| # | Sentence | Mod | No hints | Upload |', '| --- | --- | --- | --- | --- |')
rows.forEach((r, i) => {
  const cell = x => `${Math.round(x.finalMs)} ms, ${x.errors} err: ${x.text.replace(/\|/g, '/')}`
  md.push(`| ${i + 1} | ${r.sentence} | ${cell(r.mod)} | ${cell(r['no-hints'])} | ${cell(r.upload)} |`)
})
writeFileSync(path.join(HERE, 'RESULTS.md'), md.join('\n') + '\n')
console.log('\n' + JSON.stringify(summary, null, 2))
