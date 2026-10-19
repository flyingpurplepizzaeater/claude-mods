/** Where the last pre-compaction save went, '' before the first one. */
export type LastSave = string

declare module 'claude-code' {
  interface PluginState {
    'auto-compact': { compacting: boolean; lastSave: LastSave; pending: string; lastResult: string; selfSavedAt: number }
  }
}
