import { useState, useEffect, useCallback } from 'react'

export interface MemoryEntry {
  id: string
  workspace_id: string
  agent_id: string | null
  type: 'context' | 'history' | 'preference'
  key: string
  value: string
  created_at: number
  updated_at: number
}

export interface Task {
  id: string
  workspace_id: string
  title: string
  description: string | null
  notes: string | null
  status: 'pending' | 'in_progress' | 'done' | 'failed'
  assigned_agent: string | null
  created_by: string
  created_at: number
  updated_at: number
}

export function useMemory(workspaceId: string | null) {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [tasks, setTasks] = useState<Task[]>([])

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setEntries([])
      setTasks([])
      return
    }
    const [mem, tsk] = await Promise.all([
      window.swarmmind.memoryList() as Promise<MemoryEntry[]>,
      window.swarmmind.taskList() as Promise<Task[]>
    ])
    setEntries(mem ?? [])
    setTasks(tsk ?? [])
  }, [workspaceId])

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 2000)
    return () => clearInterval(interval)
  }, [refresh])

  return { entries, tasks, refresh }
}
