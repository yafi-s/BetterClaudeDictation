// Time from a press to the first audio, for the mod's native capture
// (native/voicekit.exe, WinMM) and for ffmpeg's DirectShow capture, the usual
// way a script records on Windows. Opens the default mic briefly; nothing is
// kept. Writes bench/mic-open.json for run-bench.mjs to report.
//
//   node bench/mic-open.mjs ["DirectShow device name for ffmpeg"]

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const exe = path.join(ROOT, 'native', 'voicekit.exe')
const now = () => performance.now()
const sleep = ms => new Promise(r => setTimeout(r, ms))
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]

if (!existsSync(exe)) {
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  execFileSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${exe}`, path.join(ROOT, 'native', 'VoiceKit.cs')])
}

async function voicekitRuns(n) {
  const vk = spawn(exe, ['--hotkey', '0'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  let buf = Buffer.alloc(0)
  let waiting = null
  vk.stdout.on('data', d => {
    buf = Buffer.concat([buf, d])
    while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32LE(1)) {
      const type = buf[0]
      buf = buf.subarray(5 + buf.readUInt32LE(1))
      if (type === 1 && waiting) {
        waiting(now())
        waiting = null
      }
    }
  })
  await sleep(300)
  const runs = []
  for (let i = 0; i < n; i++) {
    const t0 = now()
    const first = new Promise(r => (waiting = r))
    vk.stdin.write('start\n')
    runs.push((await first) - t0)
    vk.stdin.write('stop\n')
    await sleep(400)
  }
  vk.stdin.end('quit\n')
  return runs
}

function firstDshowMic() {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' })
  const m = /"([^"]+)" \(audio\)/.exec(out.stderr ?? '')
  return m?.[1] ?? null
}

async function ffmpegRuns(n, device) {
  const runs = []
  for (let i = 0; i < n; i++) {
    const t0 = now()
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', '20', '-i', `audio=${device}`, '-ac', '1', '-ar', '24000', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const first = await new Promise(r => ff.stdout.once('data', () => r(now())))
    runs.push(first - t0)
    ff.stdin.write('q')
    await new Promise(r => ff.once('exit', r))
    await sleep(300)
  }
  return runs
}

const results = []
const vk = await voicekitRuns(5)
results.push({ label: 'This mod: native WinMM capture (first run is a cold open)', medianMs: median(vk), runs: vk })
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0
const device = process.argv[2] ?? (hasFfmpeg ? firstDshowMic() : null)
if (hasFfmpeg && device) {
  const ff = await ffmpegRuns(3, device)
  results.push({ label: 'ffmpeg DirectShow capture, 20 ms buffer', medianMs: median(ff), runs: ff })
}
writeFileSync(path.join(HERE, 'mic-open.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2))
for (const r of results) console.log(`${r.label}: median ${Math.round(r.medianMs)} ms (${r.runs.map(Math.round).join(', ')})`)
