declare module 'claude-code' {
  interface PluginState {
    hud: {
      weather: {
        usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
        at: number
        turns: number
      } | null
      activity: string | null
      calls: Record<string, number>
      turns: { durationMs: number; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }; usd: number | null; cost: number | null }[]
      agents: { id: string; type: string; description: string; model: string; startedAt: number; endedAt: number | null; state: 'running' | 'done' | 'failed'; tokens: number }[]
      repo: {
        pr: { number: number; url: string | null; ci: 'pass' | 'fail' | 'pending' | null; passed: number; total: number } | null
        ahead: number
        behind: number
        changes: { files: number; added: number; removed: number; untracked: number }
      } | null
      history: {
        at?: number
        ctx: number | null
        hit: number | null
        five?: { pct: number | null; resetsAt: number | null } | null
        seven?: { pct: number | null; resetsAt: number | null } | null
      }[]
    }
  }
}
