declare module 'claude-code' {
  interface PluginState {
    guard: {
      weather: {
        usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
        at: number
        turns: number
      } | null
    }
  }
}
