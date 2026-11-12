export type DictationPhase = 'starting' | 'idle' | 'listening' | 'finishing' | 'unavailable'

export type DictationView = {
  phase: DictationPhase
  /** `hold` while the key is held, `locked` hands-free. */
  mode: 'hold' | 'locked' | null
  /** Recent input levels, 0..1, newest last: the band's waveform. */
  levels: number[]
  elapsedMs: number
  /** The live transcript, shown in the band when the prompt box cannot take it. */
  text: string
  isBoxLive: boolean
  /** The push-to-talk key's label, or '' when this session does not hold one. */
  hotkey: string
  /** Whether this session answers the push-to-talk key now (the one you used last). */
  isOwner: boolean
  hasKey: boolean
  notice: string | null
  noticeKind: 'error' | 'warning' | 'info' | null
}

declare module 'claude-code' {
  interface PluginState {
    'push-to-talk-dictation': { view: Shaped<DictationView> }
  }
}
