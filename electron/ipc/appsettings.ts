import { ipcMain } from 'electron'
import { getAppState, setAppState } from '../../memory/queries'
import { setAgentIdleMs } from '../pty-manager'

// Settings that the main process must react to (not just persist) when changed.
function applySideEffects(key: string, value: string): void {
  if (key === 'agentIdleMs') {
    const n = Number(value)
    if (Number.isFinite(n)) setAgentIdleMs(n)
  }
}

// Read persisted settings at startup so the main process honours them before
// any renderer round-trip.
export function loadPersistedSettings(): void {
  const idle = getAppState('agentIdleMs')
  if (idle) applySideEffects('agentIdleMs', idle)
}

export function registerAppSettingsHandlers(): void {
  ipcMain.handle('appsetting:get', (_e, key: string) => getAppState(key))
  ipcMain.handle('appsetting:set', (_e, key: string, value: string) => {
    setAppState(key, value)
    applySideEffects(key, value)
  })
}
