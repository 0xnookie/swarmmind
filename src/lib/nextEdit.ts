// Next-edit prediction ("Tab to jump", Cursor-style). After an AI edit is
// accepted, the model is asked where the *next* related change likely belongs
// (update a call site, a type, an export, a test…). This pure module validates
// and normalises that raw prediction into a usable jump target, so the model
// can never push the editor to a non-existent line or loop back onto the line we
// just edited. No editor/React dependency — unit-tested directly.

export interface NextEditPrediction {
  /** 1-based line the model points at. */
  line?: number
  /** Short instruction describing the follow-up edit. */
  instruction?: string
  /** The model's way of saying "no follow-up needed". */
  none?: boolean
}

export interface NextEditTarget {
  line: number
  instruction: string
}

/**
 * Turn a raw model prediction into a validated jump target, or null when there
 * is nothing sensible to jump to. `lineCount` clamps the line into the document;
 * `excludeLine` (the line just edited) is rejected so we never suggest jumping
 * back onto the change we just made.
 */
export function resolveNextEditTarget(
  pred: NextEditPrediction | null | undefined,
  lineCount: number,
  excludeLine?: number,
): NextEditTarget | null {
  if (!pred || pred.none) return null
  if (typeof pred.line !== 'number' || !Number.isFinite(pred.line)) return null
  if (lineCount < 1) return null
  const line = Math.min(Math.max(1, Math.floor(pred.line)), lineCount)
  const instruction = (pred.instruction ?? '').trim()
  if (!instruction) return null
  if (excludeLine != null && line === excludeLine) return null
  return { line, instruction }
}
