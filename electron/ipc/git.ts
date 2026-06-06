import { ipcMain } from 'electron'
import {
  isRepo,
  createWorktree,
  removeWorktree,
  listWorktrees,
  worktreeDiffStat,
  worktreeDiff,
  worktreeCommit,
  mergeBranch,
  getBaseBranch,
  type WorktreeInfo,
  type WorktreeDiffStat,
} from '../git-manager'

export function registerGitHandlers(): void {
  ipcMain.handle('git:isRepo', async (_e, root: string): Promise<boolean> => {
    return isRepo(root)
  })

  ipcMain.handle('git:createWorktree', async (_e, root: string, paneId: string, branchHint?: string): Promise<WorktreeInfo | { error: string }> => {
    try {
      return await createWorktree(root, paneId, branchHint)
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:removeWorktree', async (_e, root: string, worktreePath: string, branch?: string, deleteBranch?: boolean): Promise<{ ok: true } | { error: string }> => {
    try {
      await removeWorktree(root, worktreePath, branch, deleteBranch)
      return { ok: true }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:listWorktrees', async (_e, root: string): Promise<WorktreeInfo[]> => {
    return listWorktrees(root)
  })

  ipcMain.handle('git:baseBranch', async (_e, root: string): Promise<string> => {
    return getBaseBranch(root)
  })

  ipcMain.handle('git:worktreeDiffStat', async (_e, root: string, worktreePath: string, baseRef?: string): Promise<WorktreeDiffStat> => {
    return worktreeDiffStat(root, worktreePath, baseRef)
  })

  ipcMain.handle('git:worktreeDiff', async (_e, root: string, worktreePath: string, file?: string, baseRef?: string): Promise<string> => {
    return worktreeDiff(root, worktreePath, file, baseRef)
  })

  ipcMain.handle('git:worktreeCommit', async (_e, worktreePath: string, message: string): Promise<{ hash: string | null } | { error: string }> => {
    try {
      return { hash: await worktreeCommit(worktreePath, message) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:mergeBranch', async (_e, root: string, branch: string) => {
    return mergeBranch(root, branch)
  })
}
