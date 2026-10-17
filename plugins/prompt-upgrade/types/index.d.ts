export type UpgradedPrompt = string

declare module 'claude-code' {
  interface PluginState {
    'prompt-upgrade': { last: UpgradedPrompt | null }
  }
}
