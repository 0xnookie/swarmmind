import { ipcMain, shell } from 'electron'
import {
  isRepo,
  createWorktree,
  removeWorktree,
  listWorktrees,
  worktreeDiffStat,
  worktreeDiff,
  worktreeCommit,
  worktreeCommitFiles,
  mergeBranch,
  mergeQueuePreview,
  mergeQueueRun,
  getBaseBranch,
  remoteInfo,
  pushBranch,
  createPullRequest,
  branchCommits,
  type WorktreeInfo,
  type WorktreeDiffStat,
  type MergeQueuePreview,
  type MergeRunResult,
  type RemoteDescriptor,
  type PushResult,
  type PrResult,
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

  ipcMain.handle('git:worktreeCommitFiles', async (_e, worktreePath: string, message: string, files: string[]): Promise<{ hash: string | null } | { error: string }> => {
    try {
      return { hash: await worktreeCommitFiles(worktreePath, message, files) }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('git:mergeBranch', async (_e, root: string, branch: string) => {
    return mergeBranch(root, branch)
  })

  ipcMain.handle('git:mergeQueuePreview', async (_e, root: string, branches: string[], baseRef?: string): Promise<MergeQueuePreview> => {
    return mergeQueuePreview(root, branches, baseRef)
  })

  ipcMain.handle('git:mergeQueueRun', async (_e, root: string, branches: string[]): Promise<MergeRunResult[]> => {
    return mergeQueueRun(root, branches)
  })

  // ── Push & pull requests ──────────────────────────────────────────────────

  ipcMain.handle('git:remoteInfo', async (_e, root: string): Promise<RemoteDescriptor | null> => {
    return remoteInfo(root)
  })

  ipcMain.handle('git:push', async (_e, worktreePath: string, branch: string): Promise<PushResult> => {
    return pushBranch(worktreePath, branch)
  })

  ipcMain.handle('git:branchCommits', async (_e, worktreePath: string, base: string): Promise<{ hash: string; subject: string }[]> => {
    return branchCommits(worktreePath, base)
  })

  ipcMain.handle(
    'git:createPr',
    async (_e, root: string, worktreePath: string, opts: { title: string; body: string; base: string; head: string; draft?: boolean }): Promise<PrResult> => {
      return createPullRequest(root, worktreePath, opts)
    },
  )

  // Opening the compare page is the fallback when `gh` can't create the PR, so
  // it belongs next to the call that produces the URL. Non-http schemes are
  // refused: this handler takes a URL that ultimately derives from the repo's
  // own git config, and `shell.openExternal` will happily launch a `file:` or
  // custom-protocol handler.
  ipcMain.handle('shell:openExternal', async (_e, url: string): Promise<{ ok: boolean }> => {
    if (!/^https?:\/\//i.test(url)) return { ok: false }
    await shell.openExternal(url)
    return { ok: true }
  })
}
