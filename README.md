# BetterClaudeDictation

Fast, accurate push-to-talk dictation for Claude Code on Windows. Hold **Right Ctrl**, talk, let go. Your words land in Claude's prompt about half a second later, even after a long ramble.

It's a Claude Code mod (plugin name `push-to-talk-dictation`): a small bar above the prompt with a mic, a live waveform, **Done** and **Cancel**, styled after Claude Desktop's own dictation controls. Speech goes to OpenAI's `gpt-live-transcribe` while you talk, so there's almost nothing left to do when you stop.

## What it measures up to

From [`bench/RESULTS.md`](bench/RESULTS.md), on synthetic speech (Windows' built-in voice), compared with recording first and uploading the clip on release, the way most dictation tools work:

| | BetterClaudeDictation | Record, then upload |
| --- | --- | --- |
| Mic open after the key press | **33 ms** median (117 ms the first time) | ~800 ms recording with ffmpeg |
| 53-second dictation: release → full text | **0.42 s** median of 3 runs | 1.30 s |
| One sentence: release → text | 0.57 s median | 0.46 s median (0.88 s on an earlier run) |
| Word errors (10 coding sentences, 114 words) | 0 | 0 |
| Tech terms spelled and capitalized exactly | 11 of 12 | 11 of 12 |

What that means in practice:

- **Your first word doesn't get clipped.** The mic is open within a few tens of milliseconds of the key press, where an ffmpeg-based recorder takes most of a second.
- **Long dictation stays fast.** By the time you let go, every sentence but the last is already transcribed. An upload has to send and transcribe the whole clip after you stop.
- **Short sentences are a wash.** Both finish in about half a second, and network variance decides which one wins.
- **Accuracy matches** OpenAI's file transcription. The vocabulary hints (README, Kubernetes, Claude Code, ...) were worth one extra term out of twelve against streaming without them.

Claude Code's built-in dictation and Codex's dictation run inside closed apps on private services, so a script can't benchmark them. They aren't in the numbers.

## Install

You need:

- Windows 10 or 11
- Claude Code (the desktop app's Code tab, or the terminal)
- [Node.js](https://nodejs.org) 22 or newer on your `PATH`
- An [OpenAI API key](https://platform.openai.com/api-keys). Transcription costs about $0.017 per minute of audio.

**1. Install the mod.** At a Claude Code terminal prompt:

```
/plugin install push-to-talk-dictation --marketplace yafi-s/BetterClaudeDictation
```

Answer `y` to add the marketplace, then press Enter to install for your user. From a shell, the same thing is:

```bash
claude plugin install push-to-talk-dictation --marketplace yafi-s/BetterClaudeDictation
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `yafi-s/BetterClaudeDictation`, then **Add plugin**.

**2. Add your OpenAI key.** Click **Set up dictation** in the bar above the prompt, or run `/dictate key`. Notepad opens the key file; paste your key, save, and close. The mod reconnects by itself, and a toast says when OpenAI accepts the key. If `OPENAI_API_KEY` (or another `OPENAI…KEY` variable) is already set, there's nothing to do.

**3. Talk.** Hold Right Ctrl, speak, release.

### Or let Claude set it up

Paste this into Claude Code:

> Install the Claude Code plugin `push-to-talk-dictation` from the GitHub marketplace `yafi-s/BetterClaudeDictation` by running `claude plugin install push-to-talk-dictation --marketplace yafi-s/BetterClaudeDictation`, check that Node.js 22+ is on my PATH, then tell me how to add my OpenAI API key. Don't ask me for the key itself.

Put the key in yourself, through **Set up dictation**. It never needs to pass through the chat.

## Use

| Do | What happens |
| --- | --- |
| Hold **Right Ctrl**, talk, release | The text lands in the prompt when you let go |
| Click **Dictate**, or tap **Right Ctrl** | Hands-free: talk as long as you like, then click **Done** or tap again |
| **Esc** while dictating | Cancel; the prompt goes back to how it was |
| **Enter** right after you stop | Waits for your last words, then sends |
| Right Ctrl + another key | Treated as a shortcut, so no dictation starts |
| `/dictate` | Start or finish without the key |
| `/dictate status`, `devices`, `key`, `reconnect`, `cancel` | Diagnostics (including how much audio this session has sent), microphones, the key, reconnecting |

Right Ctrl works even when Claude isn't the focused window. With several Claude sessions open, Right Ctrl goes to the session on screen: switching to a session hands it the key, and so do typing in it, sending from it, or clicking its **Dictate** button. The bar shows up with the session itself, before the helper behind it has finished starting.

## Options

Set these in the plugin's settings:

- **Push-to-talk key:** Right Ctrl, Right Alt, F8, F9, Scroll Lock, Pause, or off
- **Microphone:** part of the device's name; empty uses the Windows default
- **Languages:** for example `en`, or `en, fr`
- **Vocabulary hints:** names and terms to expect
- **Latency:** `minimal`, `low`, `medium` or `high`
- **Hands-free auto-stop:** hands-free dictation stops by itself after this many seconds without speech (default 20; 0 turns it off)
- **Show words while you speak:** off by default, so the text appears when you finish; on, the words stream in dimmed and settle as they're finalized
- **Show the idle bar**

## How it works

- `hooks/register.tsx`: the Claude Code side. It draws the bar, puts the text in the prompt box, provides `/dictate`, and makes Enter wait for the final words.
- `helper/dictation-helper.mjs` (Node):
  - It keeps a configured OpenAI stream open ahead of time, so a press never waits for a connection.
  - It streams 24 kHz mono PCM16 in about 60 ms chunks. Audio captured before the stream is ready is queued, not dropped.
  - It sends audio only around speech: from half a second before you start talking until about a second after you stop. Silence stays on your machine, so it isn't billed.
  - It ends a turn at each 800 ms pause, or every 25 seconds at most, so long dictation is finalized as you go.
  - On release it adds 250 ms of silence so the last word isn't clipped.
  - Each dictation gets its own stream, so back-to-back presses never mix.
- `native/VoiceKit.cs`: opens the mic through WinMM in milliseconds and watches the push-to-talk key. It reports that one key's presses (and whether another key was pressed with it, plus Esc), so it never logs keystrokes. The helper compiles it on first run with the C# compiler that comes with Windows. No prebuilt binary is shipped.

The streaming design takes its cues from studying how Codex's desktop app does dictation: pre-warmed audio, small PCM16 frames over a WebSocket, pause-based turns, and a silence flush. None of Codex's or Claude's code is included.

## Privacy and cost

- Audio leaves your machine only while you're dictating, only while you're speaking, and only to OpenAI. OpenAI bills the audio it receives, so a mic left open in silence costs nothing, and hands-free dictation stops by itself after 20 seconds without speech.
- `/dictate status` shows how much audio this session has sent and roughly what it cost.
- The mic is open only while you dictate, plus one ~10 ms open at session start to warm the driver.
- Your key is read only by the helper process. It never reaches Claude, the model, or the chat.
- Anything in the key file that doesn't look like a key is never sent anywhere.

## Run the benchmark yourself

```powershell
powershell -File bench/make-speech.ps1   # speaks bench/sentences.txt into bench/audio
node bench/mic-open.mjs                  # mic open time, the mod's capture vs ffmpeg
node bench/run-bench.mjs                 # latency and accuracy; writes bench/RESULTS.md
```

A run costs about $0.05. To drive the real helper with a recording instead of your microphone, set `LIVE_DICTATION_FAKE_MIC` to a 24 kHz mono WAV.

## Limits

- Windows only: the mic and key helper uses Win32.
- This mod doesn't replace Claude Desktop's built-in mic button; it adds a separate, faster path beside it.
- Speech from Windows' built-in voice is cleaner than a real voice in a real room, so expect more errors than the benchmark shows. The latency numbers carry over.

## License

MIT. An independent project, not affiliated with or endorsed by Anthropic or OpenAI.
