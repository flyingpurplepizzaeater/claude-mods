import type { Todo, TodoStatus } from '../types'

// The desktop app's task list tool; TodoWrite and TaskCreate/TaskUpdate are the terminal's.
export const PLAN_TOOL = 'mcp__ccd_turn__update_plan'
// Ending the turn checks off the step still in progress; no update_plan call does it.
export const WRAP_UP_TOOL = 'mcp__ccd_turn__wrap_up'

export const asStatus = (s: unknown): TodoStatus =>
  s === 'in_progress' || s === 'completed' ? s : 'pending'

// update_plan's step-wise forms: advance, done: [n], start: n (1-based).
export function applyPlan(list: Todo[], args: Record<string, unknown>): Todo[] {
  if (Array.isArray(args.items)) {
    return args.items.map((item: any, i: number) => ({
      id: `p${i}`,
      text: String(item?.content ?? ''),
      status: asStatus(item?.status),
    }))
  }
  let next = list.map(t => ({ ...t }))
  if (args.advance === true) {
    const cur = next.findIndex(t => t.status === 'in_progress')
    if (cur >= 0) next[cur].status = 'completed'
    const pending = next.findIndex((t, i) => i > cur && t.status === 'pending')
    if (pending >= 0) next[pending].status = 'in_progress'
  }
  if (Array.isArray(args.done)) {
    for (const n of args.done) if (next[Number(n) - 1]) next[Number(n) - 1].status = 'completed'
  }
  if (typeof args.start === 'number' && next[args.start - 1]) {
    next = next.map(t => (t.status === 'in_progress' ? { ...t, status: 'pending' } : t))
    next[args.start - 1].status = 'in_progress'
  }
  return next
}

// The task list after one tool call, or undefined when the call doesn't touch it.
export function nextTodos(list: Todo[], tool: string, args: Record<string, unknown>, result: unknown): Todo[] | undefined {
  if (tool === PLAN_TOOL) return applyPlan(list, args)
  if (tool === WRAP_UP_TOOL) {
    return list.some(t => t.status === 'in_progress')
      ? list.map(t => (t.status === 'in_progress' ? { ...t, status: 'completed' } : t))
      : undefined
  }
  if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
    return (args.todos as any[]).map((t, i) => ({ id: `w${i}`, text: String(t?.content ?? ''), status: asStatus(t?.status) }))
  }
  if (tool === 'TaskCreate') {
    const task = (result as any)?.task
    return task?.id ? [...list, { id: String(task.id), text: String(task.subject ?? args.subject ?? ''), status: 'pending' }] : undefined
  }
  if (tool === 'TaskUpdate' && args.taskId !== undefined) {
    const id = String(args.taskId)
    return args.status === 'deleted'
      ? list.filter(t => t.id !== id)
      : list.map(t =>
          t.id === id
            ? { ...t, status: args.status ? asStatus(args.status) : t.status, text: args.subject ? String(args.subject) : t.text }
            : t,
        )
  }
  return undefined
}
