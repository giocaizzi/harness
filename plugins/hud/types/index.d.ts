declare module 'claude-code' {
  interface PluginState {
    hud: {
      weather: {
        usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
        at: number
        turns: number
      } | null
      activity: string | null
      repo: { pr: { number: number; ci: 'pass' | 'fail' | 'pending' | null } | null; ahead: number; behind: number } | null
      history: { ctx: number | null; hit: number | null; five?: number | null; seven?: number | null }[]
    }
  }
}
