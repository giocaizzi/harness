declare module 'claude-code' {
  interface PluginState {
    sounds: {
      last: { at: number; alert: Record<string, number> } | null
    }
  }
}
