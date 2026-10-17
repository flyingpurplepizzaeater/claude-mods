declare module 'claude-code' {
  interface PluginState {
    'auto-handover': {
      // Path of the handover this session already wrote ('' none yet), so it fires once.
      handedOver: string
      // Main-loop turns finished this session.
      turnsSeen: number
    }
  }
}

export type HandoverPath = string
