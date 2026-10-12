declare module 'claude-code' {
  interface PluginState {
    guard: {
      weather: {
        usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
        at: number
        turns: number
        alert?: { ctx: number; five: boolean }
      } | null
      history: { ctx: number | null; hit: number | null; five?: number | null; seven?: number | null }[]
    }
  }
}
