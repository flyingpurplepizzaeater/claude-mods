export type SessionRow = {
  pid: number
  name: string
  status: string
  cwd: string
  sinceMs: number
  isSelf: boolean
}

export type SubagentRow = {
  id: string
  description: string
  type: string
  state: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}

export type UsageRow = {
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  contextPercent?: number
  contextTokens?: number
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export type Todo = { id: string; text: string; status: TodoStatus }

export type TestRun = {
  command: string
  verdict: 'running' | 'passed' | 'failed' | 'unknown'
  summary: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-dashboard': {
      sessions: SessionRow[]
      subagents: SubagentRow[]
      usage: UsageRow
      todos: Todo[]
      testLast: TestRun | null
      testHistory: TestRun[]
      contextWarned: number
    }
  }
}
