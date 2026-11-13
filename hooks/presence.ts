import type { ClientModule, JsonValue } from 'claude-code'

// Runs inside the app's own drawing of this session's bar. The app draws a
// session's bar when that session comes on screen, so the first call here
// means "this session is the one in view": it tells the hooks module, which
// hands this session the push-to-talk key. It draws nothing visible.
const Presence: ClientModule<JsonValue, boolean> = (_props, surface) => {
  if (surface.state === undefined) {
    surface.post({ kind: 'shown' })
    surface.setState(true)
  }
  return surface.elements.Text({ children: ' ' })
}

export default Presence
