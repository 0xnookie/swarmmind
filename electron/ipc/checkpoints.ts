import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { snapshotWorkspace, restoreWorkspace, dropCheckpointRefs } from '../git-manager'
import { checkpointInsert, checkpointList, checkpointGet, checkpointDelete } from '../../memory/queries'
import { eventEmit } from '../../memory/events'

// Checkpoints & Rewind: pin/restore whole-workspace git snapshots so a
// multi-agent run can be rolled back wholesale. Git work lives in git-manager;
// the snapshot metadata is persisted per workspace.
export function registerCheckpointHandlers(
  getWorkspaceId: () => string | null,
  getRootPath: () => string | null
): void {
  ipcMain.handle('checkpoint:create', async (_e, label?: string, trigger?: string) => {
    const wsId = getWorkspaceId()
    const root = getRootPath()
    if (!wsId || !root) return { error: 'No workspace open' }
    const id = randomUUID()
    try {
      const trees = await snapshotWorkspace(root, id)
      if (!trees.length) return { error: 'Not a git repository — nothing to checkpoint' }
      const rec = checkpointInsert(wsId, id, label?.trim() || 'Checkpoint', trigger || 'manual', trees)
      eventEmit(wsId, 'checkpoint', { payload: { label: rec.label, trigger: rec.trigger, dirs: trees.length } })
      return rec
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('checkpoint:list', () => {
    const wsId = getWorkspaceId()
    return wsId ? checkpointList(wsId) : []
  })

  ipcMain.handle('checkpoint:restore', async (_e, id: string) => {
    const wsId = getWorkspaceId()
    const root = getRootPath()
    if (!wsId || !root) return { error: 'No workspace open' }
    const rec = checkpointGet(id)
    if (!rec) return { error: 'Checkpoint not found' }
    try {
      // Safety net: snapshot the current state before rewinding so the rewind
      // itself is undoable.
      const safetyId = randomUUID()
      const safetyTrees = await snapshotWorkspace(root, safetyId)
      if (safetyTrees.length) {
        checkpointInsert(wsId, safetyId, 'Before rewind', 'pre-restore', safetyTrees)
      }
      const result = await restoreWorkspace(rec.trees)
      eventEmit(wsId, 'checkpoint', { payload: { label: rec.label, trigger: 'restore', restored: result.restored } })
      return { ok: true, ...result }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('checkpoint:delete', async (_e, id: string) => {
    const wsId = getWorkspaceId()
    const root = getRootPath()
    if (!wsId) return false
    const rec = checkpointGet(id)
    if (rec && root) await dropCheckpointRefs(root, id, rec.trees.length).catch(() => {})
    return checkpointDelete(id)
  })
}
