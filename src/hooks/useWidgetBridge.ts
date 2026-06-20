import { useEffect } from 'react'
import { runTool } from '../swarmagent/tools'

// Main-window side of the SwarmAgent desktop widget. The widget runs its own
// chat loop in a separate window but has no workspace state of its own, so it
// forwards each tool call here; the main process relays it as a `widget:runTool`
// request. We execute the tool against this (real) renderer's store/PTYs and
// send the result back, correlated by id. Mounted once in App.
//
// runTool already swallows its own errors into a string result, so the bridge
// just relays whatever it returns. We deliberately don't touch the shared
// tool-cancellation token here — that belongs to the main window's own chat
// loop; a forwarded call runs to completion (the main process also caps it with
// a 60s timeout).
export function useWidgetBridge(): void {
  useEffect(() => {
    return window.swarmmind.onWidgetRunTool(async ({ id, name, args }) => {
      const result = await runTool(name, args)
      window.swarmmind.widgetToolResult(id, result)
    })
  }, [])
}
