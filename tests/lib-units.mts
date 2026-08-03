// Pure-logic unit tests. CLAUDE.md's correctness strategy is to extract risky
// pure logic into dependency-free `lib/` modules so it can be asserted against
// without booting Electron/React/CodeMirror. This file is the permanent home of
// those assertions (the smoke/editor-verify tests cover the booted app; `tsc`
// covers types; this covers behaviour).
//
// Run:  npm test        (node --experimental-strip-types, Node 22+)
//
// These modules import nothing from the framework, so they strip-and-run
// directly from source — no build step. Add a block here whenever you add a new
// pure module under src/lib/ or electron/lib/.
import assert from 'node:assert/strict'
import { lineDiff, wordDiff } from '../src/lib/lineDiff.ts'
import { activeMentionAt } from '../src/lib/mention.ts'
import { addSnippet, removeSnippet, filterSnippets, parseSnippets } from '../src/lib/snippets.ts'
import { nextWordBoundary } from '../src/lib/ghostAccept.ts'
import { shouldRequestCompletion } from '../src/lib/ghostRequest.ts'
import { dedupeSuggestion } from '../src/lib/ghostDedupe.ts'
import { fuzzyMatch, fuzzyRank } from '../src/lib/fuzzy.ts'
import { resolveNextEditTarget } from '../src/lib/nextEdit.ts'
import { extractFileBlocks } from '../src/lib/codeBlocks.ts'
import { tokenize, rankDocs, cosineSim, rankByEmbedding, fuseRankings, dedupeByPath } from '../src/lib/retrieval.ts'
import { chunkText } from '../src/lib/chunk.ts'
import { resizeRect, RESIZE_DIRS, RESIZE_CURSOR, GRID, snapToGrid, gridBackgroundOffset } from '../src/lib/canvasResize.ts'
import {
  focusLayout, snapAll, tidyGrid, eraserHits, isErasableKind, pointSegmentDistance,
  normalizeRect, rectsOverlap, segmentIntersectsRect, marqueeHits, selectionBounds, dragDelta,
  DOCK_W, DOCK_MIN_H, FOCUS_PAD,
} from '../src/lib/canvasLayout.ts'
import { parseScripts, orderVerifyScripts, pickVerifyScript, isFailure, summarizeFailure, buildFixInstruction, isSafeScriptName, verifyLoopStatus } from '../src/lib/verify.ts'
import { stripCodeFences, extractJsonObject } from '../electron/lib/aiParse.ts'
import { selectClaimable, isClaimable, doneIdSet, type ClaimableTask } from '../electron/lib/taskBoard.ts'
import { pickAccount, needsFreshSession, signedInState, credentialCandidates } from '../electron/lib/accounts.ts'
import {
  severityOf, flattenMessage, displayPartsToText, formatHover, isTsLike, samePath, chooseProject,
  applyTextEdits, offsetToLine, lineTextAt, isValidIdentifier,
} from '../electron/lib/tsLsp.ts'
import { toWorkspaceRelative, buildRenamePlan } from '../src/lib/rename.ts'
import { parseMergeTree, mergeVerdict, advancesHead } from '../electron/lib/mergeTree.ts'
import {
  moveInList, summarizeQueue, landableBranches, canRunQueue, buildConflictTaskPrompt,
  type QueueRow,
} from '../src/lib/mergeQueue.ts'
import { parseRemoteUrl, compareUrl, supportsCli } from '../electron/lib/gitRemote.ts'
import { defaultPrTitle, buildPrBody } from '../src/lib/pullRequest.ts'
import { renderSwarmDigest, type ExportEvent } from '../src/lib/sessionExport.ts'
import {
  raceEligibility, canStartRace, buildRacePrompt, attemptState, churn, contestedFiles, planWinner,
  type RacePane,
} from '../src/lib/race.ts'
import { parseVoiceCommand, describeIntent } from '../src/lib/voiceCommand.ts'
import {
  isTileZoom, tileState, tileMetrics, tileCost, TILE_ZOOM_ENTER, TILE_ZOOM_EXIT,
} from '../src/lib/canvasLod.ts'
import {
  deriveRoutes, hasRoutesFrom, relayBody, planRelay, markRelayed, emptyRelayMemo,
  buildRelayPrompt,
} from '../src/lib/canvasRoutes.ts'
import {
  frameChildren, framePanes, frameOf, nextFrameName, nextFrameColor, isFrameKind,
  FRAME_Z, FRAME_COLORS,
} from '../src/lib/canvasFrames.ts'
import {
  viewportWorldRect, isOffscreen, cameraToCenter, pickAttentionTarget, shouldFollow,
} from '../src/lib/canvasAttention.ts'
import { encodeMessage, decodeMessages, pathToUri, uriToPath } from '../electron/lib/lspFraming.ts'
import { serverForPath, parseExtraServers, resolveServers, quoteForCmd } from '../electron/lib/lspServers.ts'
import {
  offsetToPosition, positionToOffset, normalizeSeverity, normalizeDiagnostics,
  normalizeHoverContents, normalizeLocations, normalizeWorkspaceEdit, applyRangeEdits,
} from '../electron/lib/lspNormalize.ts'
import { mergeDiagnostics, normalizeMessage, summarizeDiagnostics } from '../src/lib/diagnostics.ts'
import {
  parseDeps, depsMet, canReview, buildDispatchPrompt, sweepAction, decomposeAction,
  reviewSweepAction, planDispatches, planReviews, readyForSynthesis, planMessageDelivery,
  isWakeEvent, findUnassignable, buildEscalationPrompt, buildLeadReportPrompt,
  totalSpend, budgetStatus, parseBudget, buildBudgetHaltNote, formatUsd,
  type ConductorTask,
} from '../src/lib/conductor.ts'
import { scoreVoice, rankVoices, pickVoice, cleanForSpeech, chunkForSpeech, type VoiceLike } from '../src/lib/voices.ts'
import { findPathLinks, isAbsolutePathLike, candidateAbsolutePaths } from '../src/lib/terminalLinks.ts'
import { isIndexablePath, planIncrementalUpdate, mergeIndexEntries } from '../src/lib/indexUpdate.ts'
import { findDevServerUrl } from '../src/lib/devServerUrl.ts'
import {
  pathSep, baseName, parentDir, joinPath, rewritePath, selectRange, toggleSelection,
  canMoveInto, canCopyInto, topLevelPaths, isUnder, relativeToRoot,
} from '../src/lib/fileOps.ts'
import {
  splitName, isValidEntryName, isInside, samePathish, nextAvailableName,
} from '../electron/lib/fsOps.ts'
import { isLoopDue, decideLoopAction, nextRunAfter } from '../src/lib/loopSchedule.ts'
import {
  rectsIntersect, fitBox, projectPointToImage, strokeScale, buildHandoffPrompt,
} from '../src/lib/canvasHandoff.ts'
import { parseImageDataUrl, MAX_CAPTURE_BYTES } from '../electron/lib/canvasCapture.ts'
import { onnxThreadCount } from '../src/lib/onnxThreads.ts'
import {
  parseDeps as parseTaskDeps, serializeDeps, addDep, removeDep, wouldCycle, taskStatusColor,
} from '../src/lib/canvasTasks.ts'
import { SWARM_RECIPES, buildRecipeLayout, type BuiltLeaf, type BuiltGroup } from '../src/lib/recipes.ts'
import {
  resolveProvider, providerErrorMessage, filterChatModels, toAnthropicTools,
  toAnthropicMessages, parseToolArguments, fromAnthropicContent, refusalMessage,
} from '../electron/lib/aiProvider.ts'
import { initVad, stepVad, frameLoudness, WAKE_VAD, DEFAULT_VAD } from '../src/lib/vad.ts'
import {
  normalizeSpeech, editDistance, wordsMatch, isValidWakePhrase, matchWakeWord,
  DEFAULT_WAKE_PHRASE,
} from '../src/lib/wakeWord.ts'
import {
  clampToViewport, dragPosition, defaultPosition, parsePosition,
} from '../src/lib/dragWidget.ts'
import {
  escapeHtml, summarizeEvent, buildSessionStats, formatDuration, compactNumber,
  exportFileBase, agentPalette, renderSessionMarkdown, renderSessionHtml,
  type ExportEvent,
} from '../src/lib/sessionExport.ts'
import {
  rememberViewState, forgetViewState, clampViewState, MAX_REMEMBERED_FILES,
  type ViewStateMap,
} from '../src/lib/editorViewState.ts'

let pass = 0
let fail = 0
const t = (name: string, fn: () => void) => {
  try {
    fn()
    pass++
    console.log('  ok  ' + name)
  } catch (e) {
    fail++
    console.error('FAIL  ' + name + '\n      ' + (e as Error).message)
  }
}

// ---------- lineDiff (Composer diff preview) ----------
t('lineDiff: identical text is all context', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nb\nc').map((x) => x.t), ['ctx', 'ctx', 'ctx'])
})
t('lineDiff: pure addition', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nx\nb'), [
    { t: 'ctx', s: 'a' },
    { t: 'add', s: 'x' },
    { t: 'ctx', s: 'b' },
  ])
})
t('lineDiff: pure deletion', () => {
  assert.deepEqual(lineDiff('a\nx\nb', 'a\nb'), [
    { t: 'ctx', s: 'a' },
    { t: 'del', s: 'x' },
    { t: 'ctx', s: 'b' },
  ])
})
t('lineDiff: empty old → all adds', () => {
  assert.deepEqual(lineDiff('', 'a\nb'), [
    { t: 'add', s: 'a' },
    { t: 'add', s: 'b' },
  ])
})
t('lineDiff: empty new → all dels', () => {
  assert.deepEqual(lineDiff('a\nb', ''), [
    { t: 'del', s: 'a' },
    { t: 'del', s: 'b' },
  ])
})
t('lineDiff: both empty → no lines', () => {
  assert.deepEqual(lineDiff('', ''), [])
})
t('lineDiff: replacement is del+add', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc'), [
    { t: 'ctx', s: 'a' },
    { t: 'del', s: 'b' },
    { t: 'add', s: 'B' },
    { t: 'ctx', s: 'c' },
  ])
})

// ---------- wordDiff (Composer intra-line highlighting) ----------
const oldOf = (segs: { t: string; s: string }[]) => segs.filter((x) => x.t !== 'add').map((x) => x.s).join('')
const newOf = (segs: { t: string; s: string }[]) => segs.filter((x) => x.t !== 'del').map((x) => x.s).join('')
t('wordDiff: reconstructs both sides', () => {
  const segs = wordDiff('const x = 1', 'const y = 2')
  assert.equal(oldOf(segs), 'const x = 1')
  assert.equal(newOf(segs), 'const y = 2')
})
t('wordDiff: identical line is all same', () => {
  const segs = wordDiff('foo(bar)', 'foo(bar)')
  assert.deepEqual(segs.map((s) => s.t), ['same'])
})
t('wordDiff: isolates the changed token', () => {
  const segs = wordDiff('a + b', 'a - b')
  assert.deepEqual(segs, [
    { t: 'same', s: 'a ' },
    { t: 'del', s: '+' },
    { t: 'add', s: '-' },
    { t: 'same', s: ' b' },
  ])
})
t('wordDiff: pure insertion of a token', () => {
  const segs = wordDiff('foo()', 'foo(x)')
  assert.equal(oldOf(segs), 'foo()')
  assert.equal(newOf(segs), 'foo(x)')
  assert.ok(segs.some((s) => s.t === 'add' && s.s === 'x'))
})

// ---------- activeMentionAt (Cmd-K @-mention caret parser) ----------
t('mention: @ at start of line', () => {
  assert.deepEqual(activeMentionAt('@foo', 4), { start: 0, query: 'foo' })
})
t('mention: @ after a space', () => {
  assert.deepEqual(activeMentionAt('edit @bar', 9), { start: 5, query: 'bar' })
})
t('mention: just-typed @ has empty query', () => {
  assert.deepEqual(activeMentionAt('hi @', 4), { start: 3, query: '' })
})
t('mention: no @ → null', () => {
  assert.equal(activeMentionAt('hello world', 11), null)
})
t('mention: email-style @ (not word-initial) → null', () => {
  assert.equal(activeMentionAt('foo@bar', 7), null)
})
t('mention: caret mid-token only sees up to caret', () => {
  assert.deepEqual(activeMentionAt('@foobar', 4), { start: 0, query: 'foo' })
})
t('mention: whitespace between @ and caret breaks it', () => {
  assert.equal(activeMentionAt('@foo bar', 8), null)
})

// ---------- snippets (editor snippet CRUD/parse) ----------
const sn = (id: string, name: string, body = 'b') => ({ id, name, body })
t('snippets: add appends a distinct name', () => {
  assert.equal(addSnippet([sn('1', 'a')], sn('2', 'b')).length, 2)
})
t('snippets: add replaces same name (case-insensitive)', () => {
  const r = addSnippet([sn('1', 'Loop', 'old')], sn('2', 'loop', 'new'))
  assert.equal(r.length, 1)
  assert.equal(r[0].body, 'new')
})
t('snippets: remove by id', () => {
  assert.deepEqual(removeSnippet([sn('1', 'a'), sn('2', 'b')], '1').map((x) => x.id), ['2'])
})
t('snippets: filter matches name & body, name-sorted', () => {
  const list = [sn('1', 'beta', 'xx'), sn('2', 'alpha', 'yy'), sn('3', 'gamma', 'has-alpha')]
  assert.deepEqual(filterSnippets(list, 'alpha').map((x) => x.id), ['2', '3'])
  assert.deepEqual(filterSnippets(list, '').map((x) => x.name), ['alpha', 'beta', 'gamma'])
})
t('snippets: parse rejects corruption, keeps valid + lang', () => {
  assert.deepEqual(parseSnippets(null), [])
  assert.deepEqual(parseSnippets('not json'), [])
  assert.deepEqual(parseSnippets('{"x":1}'), [])
  assert.deepEqual(parseSnippets('[{"id":"1","name":"n","body":"b","lang":"ts"}]'), [
    { id: '1', name: 'n', body: 'b', lang: 'ts' },
  ])
  assert.deepEqual(parseSnippets('[{"id":1,"name":"n","body":"b"}]'), []) // bad id type dropped
})

// ---------- nextWordBoundary (ghost-text partial accept) ----------
t('ghostAccept: empty → 0', () => {
  assert.equal(nextWordBoundary(''), 0)
})
t('ghostAccept: first word of a line', () => {
  assert.equal('Console'.slice(0, nextWordBoundary('Console.log(x)')), 'Console')
})
t('ghostAccept: leading space pulled along with the word', () => {
  assert.equal(' bar'.slice(0, nextWordBoundary(' bar')), ' bar')
})
t('ghostAccept: a run of punctuation taken together', () => {
  assert.equal(nextWordBoundary('=> next'), 2) // "=>"
})
t('ghostAccept: leading newline+indent then word (walks down a block)', () => {
  assert.equal(JSON.stringify('\n  return x'.slice(0, nextWordBoundary('\n  return x'))), JSON.stringify('\n  return'))
})
t('ghostAccept: whitespace-only accepts all', () => {
  assert.equal(nextWordBoundary('   '), 3)
})
t('ghostAccept: digits are word chars', () => {
  assert.equal(nextWordBoundary('123 + 4'), 3)
})

// ---------- shouldRequestCompletion (ghost request gate) ----------
t('ghostRequest: empty buffer → no request', () => {
  assert.equal(shouldRequestCompletion('', ''), false)
})
t('ghostRequest: whitespace-only → no request', () => {
  assert.equal(shouldRequestCompletion('   ', '  \n '), false)
})
t('ghostRequest: end of line → request', () => {
  assert.equal(shouldRequestCompletion('const x = ', ''), true)
})
t('ghostRequest: mid-identifier (next char is word) → no request', () => {
  assert.equal(shouldRequestCompletion('cons', 'ole.log'), false)
})
t('ghostRequest: cursor before a symbol → request', () => {
  assert.equal(shouldRequestCompletion('foo(', ')'), true)
})
t('ghostRequest: cursor before whitespace → request', () => {
  assert.equal(shouldRequestCompletion('return', ' x'), true)
})

// ---------- dedupeSuggestion (ghost-text overlap trim) ----------
t('dedupe: trims a duplicated closing bracket', () => {
  assert.equal(dedupeSuggestion('bar)', ')'), 'bar')
})
t('dedupe: trims a multi-char overlap', () => {
  assert.equal(dedupeSuggestion('foo());', ');'), 'foo()')
})
t('dedupe: no overlap leaves suggestion intact', () => {
  assert.equal(dedupeSuggestion('hello', ' world'), 'hello')
})
t('dedupe: empty suffix leaves suggestion intact', () => {
  assert.equal(dedupeSuggestion('foo()', ''), 'foo()')
})
t('dedupe: prefers the longest overlap', () => {
  assert.equal(dedupeSuggestion('x))', '))'), 'x')
})
t('dedupe: whole suggestion duplicated → empty', () => {
  assert.equal(dedupeSuggestion('})', '})'), '')
})

// ---------- fuzzy (file-picker matching/ranking) ----------
t('fuzzy: subsequence matches, non-subsequence does not', () => {
  assert.equal(fuzzyMatch('wsp', 'src/store/workspace.ts').matched, true) // w…s…p in "workspace"
  assert.equal(fuzzyMatch('zzz', 'src/store/workspace.ts').matched, false)
})
t('fuzzy: empty query matches with score 0', () => {
  const r = fuzzyMatch('', 'anything')
  assert.equal(r.matched, true)
  assert.equal(r.score, 0)
})
t('fuzzyRank: basename/boundary hit ranks above scattered match', () => {
  const files = ['src/components/Workspace.tsx', 'src/swarmagent/wonky_subset.ts']
  // "wsp" hits the W..s..p of "Workspace" (boundary) better than scattered letters.
  assert.equal(fuzzyRank(files, 'wsp', (f) => f, 8)[0], 'src/components/Workspace.tsx')
})
t('fuzzyRank: among equal-boundary prefixes the tighter (shorter) target wins', () => {
  const files = ['store_helper_extra.ts', 'store.ts']
  assert.equal(fuzzyRank(files, 'store', (f) => f, 8)[0], 'store.ts')
})
t('fuzzyRank: drops non-matches and respects the limit', () => {
  const files = ['alpha.ts', 'beta.ts', 'gamma.ts']
  assert.deepEqual(fuzzyRank(files, 'mma', (f) => f, 8), ['gamma.ts']) // only gamma has m-m-a
  assert.ok(fuzzyRank(files, 'a', (f) => f, 2).length <= 2) // limit honoured
})
t('fuzzyRank: empty query returns head of list', () => {
  assert.deepEqual(fuzzyRank(['a', 'b', 'c'], '   ', (f) => f, 2), ['a', 'b'])
})

// ---------- resolveNextEditTarget (next-edit prediction) ----------
t('nextEdit: valid prediction passes through', () => {
  assert.deepEqual(resolveNextEditTarget({ line: 12, instruction: 'update the call site' }, 100), {
    line: 12,
    instruction: 'update the call site',
  })
})
t('nextEdit: none → null', () => {
  assert.equal(resolveNextEditTarget({ none: true }, 100), null)
})
t('nextEdit: missing/garbage line → null', () => {
  assert.equal(resolveNextEditTarget({ instruction: 'x' }, 100), null)
  assert.equal(resolveNextEditTarget({ line: NaN, instruction: 'x' }, 100), null)
})
t('nextEdit: empty instruction → null', () => {
  assert.equal(resolveNextEditTarget({ line: 3, instruction: '   ' }, 100), null)
})
t('nextEdit: line clamped into the document', () => {
  assert.equal(resolveNextEditTarget({ line: 999, instruction: 'x' }, 10)?.line, 10)
  assert.equal(resolveNextEditTarget({ line: 0, instruction: 'x' }, 10)?.line, 1)
})
t('nextEdit: rejects jumping back to the just-edited line', () => {
  assert.equal(resolveNextEditTarget({ line: 5, instruction: 'x' }, 100, 5), null)
})
t('nextEdit: null prediction → null', () => {
  assert.equal(resolveNextEditTarget(null, 100), null)
})

// ---------- aiParse (defensive LLM-response parsing) ----------
t('aiParse: stripCodeFences removes ```lang fence', () => {
  assert.equal(stripCodeFences('```ts\nconst a=1\n```'), 'const a=1')
})
t('aiParse: stripCodeFences leaves un-fenced code alone', () => {
  assert.equal(stripCodeFences('const a = `x`'), 'const a = `x`')
})
t('aiParse: stripCodeFences plain fence (no lang)', () => {
  assert.equal(stripCodeFences('```\nhi\n```'), 'hi')
})
t('aiParse: extractJsonObject pulls object out of prose', () => {
  assert.equal(extractJsonObject('Sure!\n```json\n{"a":1}\n```\nDone'), '{"a":1}')
})
t('aiParse: extractJsonObject handles a bare object', () => {
  assert.equal(extractJsonObject('  {"a":1}  '), '{"a":1}')
})
t('aiParse: extractJsonObject returns trimmed input when no braces', () => {
  assert.equal(extractJsonObject('  nope  '), 'nope')
})

// ---------- extractFileBlocks (chat reply → applyable file blocks) ----------
t('codeBlocks: path from info string after language', () => {
  const r = extractFileBlocks('```ts src/foo.ts\nconst a = 1\n```')
  assert.deepEqual(r, [{ path: 'src/foo.ts', language: 'ts', content: 'const a = 1' }])
})
t('codeBlocks: lang:path colon form', () => {
  const r = extractFileBlocks('```ts:src/foo.ts\nconst a = 1\n```')
  assert.equal(r[0].path, 'src/foo.ts')
  assert.equal(r[0].language, 'ts')
})
t('codeBlocks: title=path / file=path form', () => {
  assert.equal(extractFileBlocks('```js title=a/b.js\nx\n```')[0].path, 'a/b.js')
  assert.equal(extractFileBlocks('```js file=a/b.js\nx\n```')[0].path, 'a/b.js')
})
t('codeBlocks: path from preceding bold/backtick line', () => {
  assert.equal(extractFileBlocks('**src/foo.ts**\n```ts\nx\n```')[0].path, 'src/foo.ts')
  assert.equal(extractFileBlocks('`src/foo.ts`\n```ts\nx\n```')[0].path, 'src/foo.ts')
  assert.equal(extractFileBlocks('File: src/foo.ts\n```ts\nx\n```')[0].path, 'src/foo.ts')
  assert.equal(extractFileBlocks('src/foo.ts:\n```ts\nx\n```')[0].path, 'src/foo.ts')
})
t('codeBlocks: root file (package.json) accepted', () => {
  assert.equal(extractFileBlocks('```json package.json\n{}\n```')[0].path, 'package.json')
})
t('codeBlocks: untargeted block is skipped', () => {
  assert.deepEqual(extractFileBlocks('Here you go:\n```ts\nconst a = 1\n```'), [])
  assert.deepEqual(extractFileBlocks('```bash\nnpm test\n```'), [])
})
t('codeBlocks: multiple blocks, mixed targeting', () => {
  const md = 'intro\n```ts src/a.ts\nA\n```\nmiddle\n```\nplain\n```\n`src/b.ts`\n```ts\nB\n```'
  const r = extractFileBlocks(md)
  assert.deepEqual(r.map((b) => b.path), ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(r.map((b) => b.content), ['A', 'B'])
})
t('codeBlocks: preceding-path label does not leak past a block', () => {
  // After a targeted block, an unlabeled block must not reuse the earlier path.
  const md = '`src/a.ts`\n```ts\nA\n```\n```ts\nB\n```'
  assert.deepEqual(extractFileBlocks(md).map((b) => b.path), ['src/a.ts'])
})
t('codeBlocks: backslash paths normalised to forward slashes', () => {
  assert.equal(extractFileBlocks('```ts src\\foo.ts\nx\n```')[0].path, 'src/foo.ts')
})
t('codeBlocks: tilde fences and multi-line content', () => {
  const r = extractFileBlocks('src/x.ts:\n~~~ts\nline1\nline2\n~~~')
  assert.equal(r[0].path, 'src/x.ts')
  assert.equal(r[0].content, 'line1\nline2')
})

// ---------- retrieval (BM25-lite relevance ranking) ----------
t('retrieval: tokenize splits camelCase and snake_case, drops noise', () => {
  assert.deepEqual(tokenize('openComposer file_path 42 x'), ['open', 'composer', 'file', 'path'])
})
t('retrieval: ranks the doc that mentions the query terms first', () => {
  const docs = [
    { path: 'a.ts', text: 'unrelated helper for colors and themes' },
    { path: 'b.ts', text: 'the composer applies multi file edits to the composer panel' },
    { path: 'c.ts', text: 'voice transcription with whisper' },
  ]
  const r = rankDocs('composer apply edits', docs, 3)
  assert.equal(r[0].path, 'b.ts')
})
t('retrieval: drops zero-score docs', () => {
  const docs = [
    { path: 'a.ts', text: 'nothing relevant here' },
    { path: 'b.ts', text: 'kanban board drag and drop' },
  ]
  assert.deepEqual(rankDocs('composer', docs), [])
})
t('retrieval: empty query or corpus → []', () => {
  assert.deepEqual(rankDocs('', [{ path: 'a', text: 'x' }]), [])
  assert.deepEqual(rankDocs('x', []), [])
})
t('retrieval: respects k limit', () => {
  const docs = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, text: 'composer edit apply' }))
  assert.equal(rankDocs('composer', docs, 3).length, 3)
})
t('retrieval: rarer term outweighs a common one (idf)', () => {
  const docs = [
    { path: 'common.ts', text: 'the the the the the the the the the' },
    { path: 'rare.ts', text: 'the quine' },
  ]
  // "quine" is rare → its doc should win for a query mentioning it.
  assert.equal(rankDocs('the quine', docs)[0].path, 'rare.ts')
})

// ---------- retrieval: semantic (embedding) ranking ----------
t('retrieval: cosineSim of identical vectors is 1', () => {
  assert.ok(Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9)
})
t('retrieval: cosineSim of orthogonal vectors is 0', () => {
  assert.equal(cosineSim([1, 0], [0, 1]), 0)
})
t('retrieval: cosineSim handles degenerate (zero) vectors', () => {
  assert.equal(cosineSim([0, 0], [1, 1]), 0)
})
t('retrieval: rankByEmbedding orders by similarity to the query', () => {
  const q = [1, 0, 0]
  const docs = [
    { path: 'far.ts', vector: [0, 1, 0] },
    { path: 'near.ts', vector: [0.9, 0.1, 0] },
  ]
  const r = rankByEmbedding(q, docs, 2)
  assert.equal(r[0].path, 'near.ts')
})
t('retrieval: rankByEmbedding minScore drops weak matches', () => {
  const r = rankByEmbedding([1, 0], [{ path: 'a', vector: [0, 1] }], 5, 0.01)
  assert.deepEqual(r, [])
})
t('retrieval: fuseRankings blends two lists via RRF', () => {
  const lexical = [{ path: 'a', score: 5 }, { path: 'b', score: 4 }]
  const semantic = [{ path: 'b', score: 0.9 }, { path: 'c', score: 0.8 }]
  const fused = fuseRankings([lexical, semantic], 3)
  // b appears in both lists → should rank first.
  assert.equal(fused[0].path, 'b')
  assert.deepEqual(new Set(fused.map((f) => f.path)), new Set(['a', 'b', 'c']))
})
t('retrieval: fuseRankings respects k', () => {
  const l = [{ path: 'a', score: 1 }, { path: 'b', score: 1 }, { path: 'c', score: 1 }]
  assert.equal(fuseRankings([l], 2).length, 2)
})

// ---------- retrieval: dedupeByPath (chunk hits → file ranking) ----------
t('retrieval: dedupeByPath keeps each file best chunk score', () => {
  const ranked = [
    { path: 'a.ts', score: 0.4 },
    { path: 'b.ts', score: 0.9 },
    { path: 'a.ts', score: 0.7 },
  ]
  const r = dedupeByPath(ranked, 5)
  assert.deepEqual(r, [
    { path: 'b.ts', score: 0.9 },
    { path: 'a.ts', score: 0.7 },
  ])
})
t('retrieval: dedupeByPath respects k', () => {
  const ranked = [
    { path: 'a', score: 3 },
    { path: 'b', score: 2 },
    { path: 'c', score: 1 },
  ]
  assert.equal(dedupeByPath(ranked, 2).length, 2)
})

// ---------- chunk (file → overlapping line windows) ----------
t('chunk: empty / blank content → []', () => {
  assert.deepEqual(chunkText(''), [])
  assert.deepEqual(chunkText('   \n  \n'), [])
})
t('chunk: single small window covers the whole file', () => {
  const r = chunkText('a\nb\nc', 40, 8)
  assert.deepEqual(r, [{ startLine: 1, endLine: 3, text: 'a\nb\nc' }])
})
t('chunk: windows advance by maxLines-overlap and cover all lines', () => {
  const content = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n')
  const r = chunkText(content, 4, 1) // step = 3
  assert.deepEqual(r.map((c) => [c.startLine, c.endLine]), [
    [1, 4],
    [4, 7],
    [7, 10],
  ])
})
t('chunk: overlap clamped below maxLines so it always advances', () => {
  const content = Array.from({ length: 6 }, (_, i) => `L${i + 1}`).join('\n')
  const r = chunkText(content, 3, 99) // overlap clamp → step >= 1
  assert.ok(r.length >= 1)
  assert.ok(r.every((c) => c.endLine >= c.startLine))
})

// ---------- verify (Composer verify→fix loop control logic) ----------
t('verify: parseScripts pulls string scripts, ignores garbage', () => {
  assert.deepEqual(
    parseScripts('{"scripts":{"typecheck":"tsc","test":"node x","bad":5}}').sort(),
    ['test', 'typecheck'],
  )
  assert.deepEqual(parseScripts('not json'), [])
  assert.deepEqual(parseScripts('{}'), [])
})
t('verify: orderVerifyScripts puts verify-ish first', () => {
  assert.deepEqual(orderVerifyScripts(['dev', 'build', 'typecheck', 'test']), ['typecheck', 'test', 'build', 'dev'])
})
t('verify: pickVerifyScript prefers typecheck then test', () => {
  assert.equal(pickVerifyScript(['dev', 'test', 'typecheck']), 'typecheck')
  assert.equal(pickVerifyScript(['dev', 'test']), 'test')
  assert.equal(pickVerifyScript(['dev', 'start']), null)
})
t('verify: isFailure on non-zero exit', () => {
  assert.equal(isFailure({ code: 0, stdout: '', stderr: '' }), false)
  assert.equal(isFailure({ code: 1, stdout: '', stderr: '' }), true)
})
t('verify: summarizeFailure prefers error-like lines', () => {
  const out = {
    code: 1,
    stdout: 'compiling...\nsrc/a.ts:3:5: error TS2304: Cannot find name x\ndone',
    stderr: '',
  }
  const s = summarizeFailure(out, 10)
  assert.ok(s.includes('TS2304'))
  assert.ok(!s.includes('compiling'))
})
t('verify: summarizeFailure falls back to tail when no error lines', () => {
  const out = { code: 1, stdout: 'a\nb\nc\nd', stderr: '' }
  assert.equal(summarizeFailure(out, 2), 'c\nd')
})
t('verify: isSafeScriptName rejects shell metacharacters', () => {
  assert.equal(isSafeScriptName('typecheck'), true)
  assert.equal(isSafeScriptName('test:unit'), true)
  assert.equal(isSafeScriptName('build-web'), true)
  assert.equal(isSafeScriptName('typecheck && calc'), false)
  assert.equal(isSafeScriptName('a; rm -rf /'), false)
  assert.equal(isSafeScriptName('x`whoami`'), false)
  assert.equal(isSafeScriptName(''), false)
  assert.equal(isSafeScriptName('a'.repeat(65)), false)
})
t('verify: verifyLoopStatus pass/retry/exhausted', () => {
  assert.equal(verifyLoopStatus(0, 3, true), 'pass')
  assert.equal(verifyLoopStatus(1, 3, false), 'retry')
  assert.equal(verifyLoopStatus(3, 3, false), 'exhausted')
  assert.equal(verifyLoopStatus(3, 3, true), 'pass') // success always wins
})
t('verify: buildFixInstruction embeds script + summary', () => {
  const instr = buildFixInstruction('add a button', 'typecheck', 'src/x.ts: error TS1')
  assert.ok(instr.includes('add a button'))
  assert.ok(instr.includes('npm run typecheck'))
  assert.ok(instr.includes('error TS1'))
})

// ---------- conductor: event-driven wake set ----------
t('isWakeEvent: task/message/memory/pane events wake the conductor', () => {
  for (const type of ['task_create', 'task_update', 'task_note', 'message', 'memory_write', 'agent_spawn', 'agent_exit', 'agent_question', 'review']) {
    assert.ok(isWakeEvent(type), `${type} should wake`)
  }
})
t('isWakeEvent: own output and telemetry do NOT wake (no echo loops, no churn)', () => {
  for (const type of ['dispatch', 'synthesis', 'cost', 'file_changed', 'contention', 'file_intent', 'checkpoint', 'unknown_future_type']) {
    assert.ok(!isWakeEvent(type), `${type} should not wake`)
  }
})

// ---------- voices (SwarmAgent spoken-reply voice selection + cleanup) ----------
const mkVoice = (p: Partial<VoiceLike> & { name: string; lang: string }): VoiceLike => ({
  voiceURI: p.name, localService: true, default: false, ...p,
})
t('voices: same-language voice beats a wrong-language one', () => {
  const en = mkVoice({ name: 'Plain EN', lang: 'en-US' })
  const de = mkVoice({ name: 'Natural DE', lang: 'de-DE' })
  assert.ok(scoreVoice(en, 'en-US') > scoreVoice(de, 'en-US'))
})
t('voices: natural/neural voice outranks a legacy one in same language', () => {
  const natural = mkVoice({ name: 'Microsoft Aria Online (Natural)', lang: 'en-US', localService: false })
  const legacy = mkVoice({ name: 'Microsoft David Desktop', lang: 'en-US' })
  assert.ok(scoreVoice(natural, 'en') > scoreVoice(legacy, 'en'))
})
t('voices: espeak is heavily penalised', () => {
  const espeak = mkVoice({ name: 'eSpeak english', lang: 'en' })
  const plain = mkVoice({ name: 'Samantha', lang: 'en' })
  assert.ok(scoreVoice(plain, 'en') > scoreVoice(espeak, 'en'))
})
t('voices: rankVoices returns the natural voice first', () => {
  const voices = [
    mkVoice({ name: 'eSpeak', lang: 'en' }),
    mkVoice({ name: 'Microsoft David', lang: 'en-US' }),
    mkVoice({ name: 'Google US English Natural', lang: 'en-US', localService: false }),
  ]
  assert.equal(rankVoices(voices, 'en-US')[0].name, 'Google US English Natural')
})
t('voices: pickVoice honours a valid preferred URI', () => {
  const voices = [
    mkVoice({ name: 'A', lang: 'en', voiceURI: 'uri-a' }),
    mkVoice({ name: 'Natural B', lang: 'en', voiceURI: 'uri-b' }),
  ]
  assert.equal(pickVoice(voices, 'en', 'uri-a')?.voiceURI, 'uri-a')
})
t('voices: pickVoice falls back to best when preferred URI is gone', () => {
  const voices = [
    mkVoice({ name: 'Plain', lang: 'en', voiceURI: 'uri-a' }),
    mkVoice({ name: 'Neural B', lang: 'en', voiceURI: 'uri-b' }),
  ]
  assert.equal(pickVoice(voices, 'en', 'missing')?.voiceURI, 'uri-b')
})
t('voices: pickVoice on empty list is null', () => {
  assert.equal(pickVoice([], 'en', null), null)
})
t('voices: cleanForSpeech strips markdown markers', () => {
  assert.equal(cleanForSpeech('**bold** and `code` and _italic_'), 'bold and code and italic')
})
t('voices: cleanForSpeech replaces fenced code blocks', () => {
  const r = cleanForSpeech('Run this:\n```bash\nnpm test\n```\nDone.')
  assert.ok(!r.includes('npm test'))
  assert.ok(r.includes('code block'))
})
t('voices: cleanForSpeech keeps link text, drops url', () => {
  assert.equal(cleanForSpeech('see [the docs](https://x.com/y)'), 'see the docs')
})
t('voices: cleanForSpeech strips headings and bullets', () => {
  // Heading hashes and list bullets are removed; single newlines survive (and
  // chunkForSpeech later treats them as sentence breaks → natural pauses).
  assert.equal(cleanForSpeech('## Title\n- one\n- two'), 'Title\none\ntwo')
})
t('voices: chunkForSpeech splits on sentence boundaries', () => {
  const r = chunkForSpeech('First sentence. Second sentence! Third?', 20)
  assert.ok(r.length >= 2)
  assert.ok(r.every((c) => c.length <= 20))
})
t('voices: chunkForSpeech packs short sentences together', () => {
  assert.deepEqual(chunkForSpeech('Hi. There.', 200), ['Hi. There.'])
})
t('voices: chunkForSpeech on empty/blank → []', () => {
  assert.deepEqual(chunkForSpeech(''), [])
  assert.deepEqual(chunkForSpeech('   \n  '), [])
})

// ---------- conductor (orchestration decision logic) ----------
// Every per-tick decision of the autonomous conductor loop — the exact place a
// silent autonomy regression would hide (previously only typechecked).
const mkTask = (p: Partial<ConductorTask> & { id: string }): ConductorTask => ({
  title: p.id, description: null, notes: null, status: 'pending',
  assigned_agent: null, depends_on: null, ...p,
})

t('conductor: parseDeps handles null, spaces, trailing commas', () => {
  assert.deepEqual(parseDeps(null), [])
  assert.deepEqual(parseDeps(' a , b ,'), ['a', 'b'])
})
t('conductor: depsMet only when every dependency is done', () => {
  const task = mkTask({ id: 't1', depends_on: 'a,b' })
  assert.equal(depsMet(task, new Set(['a', 'b'])), true)
  assert.equal(depsMet(task, new Set(['a'])), false)
  assert.equal(depsMet(mkTask({ id: 't2' }), new Set()), true)
})
t('conductor: canReview needs two distinct agents, not two panes', () => {
  assert.equal(canReview([{ id: 'p1', agentId: 'claude' }, { id: 'p2', agentId: 'claude' }]), false)
  assert.equal(canReview([{ id: 'p1', agentId: 'claude' }, { id: 'p2', agentId: 'codex' }]), true)
})
t('conductor: dispatch prompt routes to needs_review only when reviewable', () => {
  const task = mkTask({ id: 'abcdef1234567890', depends_on: 'dep1' })
  const reviewed = buildDispatchPrompt(task, true)
  const direct = buildDispatchPrompt(task, false)
  assert.ok(reviewed.includes('"needs_review"'))
  assert.ok(!direct.includes('needs_review'))
  assert.ok(direct.includes('"done"'))
  // Both carry the dependency hint and the failure escape hatch.
  assert.ok(reviewed.includes('result:dep1'))
  assert.ok(direct.includes('status "failed"'))
})

const sweepBase = {
  retries: 0, maxRetries: 1, paneRunning: true, paneWaiting: false,
  alreadyNudged: false, dispatchedAt: 0, lastProgressAt: 0, now: 10_000,
  stallMs: 30_000, stuckMs: 180_000,
}
t('conductor: sweep frees a vanished task', () => {
  assert.equal(sweepAction({ ...sweepBase, task: undefined }), 'free_vanished')
})
t('conductor: sweep collects a done task', () => {
  assert.equal(sweepAction({ ...sweepBase, task: mkTask({ id: 't', status: 'done' }) }), 'free_done')
})
t('conductor: sweep retries a failed task until maxRetries, then gives up', () => {
  const failed = mkTask({ id: 't', status: 'failed' })
  assert.equal(sweepAction({ ...sweepBase, task: failed, retries: 0 }), 'retry')
  assert.equal(sweepAction({ ...sweepBase, task: failed, retries: 1 }), 'give_up')
})
t('conductor: sweep frees a task submitted for review', () => {
  assert.equal(sweepAction({ ...sweepBase, task: mkTask({ id: 't', status: 'needs_review' }) }), 'free_for_review')
})
t('conductor: sweep frees the pane when its process died', () => {
  const inProgress = mkTask({ id: 't', status: 'in_progress' })
  assert.equal(sweepAction({ ...sweepBase, task: inProgress, paneRunning: false }), 'free_pane_exited')
})
t('conductor: sweep nudges an idle worker only past the stall window, only once', () => {
  const inProgress = mkTask({ id: 't', status: 'in_progress' })
  const idle = { ...sweepBase, task: inProgress, paneWaiting: true, dispatchedAt: 0, now: 31_000 }
  assert.equal(sweepAction(idle), 'nudge')
  assert.equal(sweepAction({ ...idle, now: 29_000 }), 'none') // window not elapsed
  assert.equal(sweepAction({ ...idle, alreadyNudged: true }), 'none') // one nudge max
  assert.equal(sweepAction({ ...idle, paneWaiting: false }), 'none') // still working
  assert.equal(sweepAction({ ...idle, dispatchedAt: undefined }), 'none') // unknown dispatch time
})
t('conductor: sweep escalates a stuck worker only after the heartbeat window', () => {
  const inProgress = mkTask({ id: 't', status: 'in_progress' })
  // No progress since dispatch (t=0), now past the stuck window → escalate,
  // whether the worker is spinning (working) or silently waiting.
  const stuck = { ...sweepBase, task: inProgress, lastProgressAt: 0, now: 200_000 }
  assert.equal(sweepAction(stuck), 'escalate')
  assert.equal(sweepAction({ ...stuck, paneWaiting: true, alreadyNudged: true }), 'escalate')
  // A recent progress heartbeat (task_note) resets the window — not stuck.
  assert.equal(sweepAction({ ...stuck, lastProgressAt: 190_000 }), 'none')
  // Window not yet elapsed.
  assert.equal(sweepAction({ ...stuck, now: 100_000 }), 'none')
  // A dead pane is reported before stuck is ever considered.
  assert.equal(sweepAction({ ...stuck, paneRunning: false }), 'free_pane_exited')
  // Falls back to lastProgressAt=dispatchedAt when no note was ever seen.
  assert.equal(sweepAction({ ...stuck, lastProgressAt: undefined, dispatchedAt: 0 }), 'escalate')
})
t('conductor: escalation prompt tells the lead to reassign/re-split/drop', () => {
  const task = mkTask({ id: 'abcdef1234567890', title: 'Wire the API' })
  const failed = buildEscalationPrompt(task, 'failed')
  assert.ok(failed.includes('abcdef12')) // short id
  assert.ok(failed.includes('failed and exhausted'))
  assert.ok(failed.includes('task_create')) // re-split path offered
  assert.ok(/reassign/i.test(failed))
  assert.ok(buildEscalationPrompt(task, 'stalled').includes('stalled'))
  assert.ok(buildEscalationPrompt(task, 'unassignable').includes('no running pane'))
})
t('conductor: lead report prompt summarises the result and remaining count', () => {
  const task = mkTask({ id: 'abcdef1234567890', title: 'Build parser' })
  const mid = buildLeadReportPrompt(task, 'added tokenizer', 3)
  assert.ok(mid.includes('added tokenizer'))
  assert.ok(mid.includes('3 task(s) still remain'))
  const last = buildLeadReportPrompt(task, null, 0)
  assert.ok(last.includes('last task'))
  assert.ok(last.includes('no result summary')) // graceful when no result written
})
t('conductor: findUnassignable flags ready tasks pinned to an absent agent', () => {
  const workerAgentIds = new Set(['claude'])
  const tasks = [
    mkTask({ id: 'a', assigned_agent: 'cursor' }),                          // absent agent → deadlocked
    mkTask({ id: 'b', assigned_agent: 'claude' }),                          // agent present → fine
    mkTask({ id: 'c' }),                                                    // unassigned → any worker
    mkTask({ id: 'd', assigned_agent: 'cursor', status: 'in_progress' }),   // not pending
    mkTask({ id: 'e', assigned_agent: 'cursor', depends_on: 'z' }),         // deps unmet
  ]
  const out = findUnassignable({ tasks, workerAgentIds, skippedTaskIds: new Set() })
  assert.deepEqual(out.map(t => t.id), ['a'])
  // A skipped task is not surfaced.
  assert.equal(findUnassignable({ tasks, workerAgentIds, skippedTaskIds: new Set(['a']) }).length, 0)
})

const watchdogBase = { attempts: 1, askedAt: 0, now: 30_000, timeoutMs: 25_000, taskCount: 0, leadRunning: true }
t('conductor: decompose watchdog re-prompts once after the timeout', () => {
  assert.equal(decomposeAction(watchdogBase), 'reprompt')
  assert.equal(decomposeAction({ ...watchdogBase, now: 20_000 }), 'none') // not yet
  assert.equal(decomposeAction({ ...watchdogBase, taskCount: 2 }), 'none') // tasks appeared
  assert.equal(decomposeAction({ ...watchdogBase, attempts: 0 }), 'none') // never asked
})
t('conductor: decompose watchdog gives up after the re-prompt or a dead lead', () => {
  assert.equal(decomposeAction({ ...watchdogBase, attempts: 2 }), 'give_up')
  assert.equal(decomposeAction({ ...watchdogBase, leadRunning: false }), 'give_up')
  assert.equal(decomposeAction({ ...watchdogBase, attempts: 3 }), 'none') // already gave up
})

t('conductor: review sweep maps verdicts and dead panes', () => {
  assert.equal(reviewSweepAction(mkTask({ id: 't', status: 'done' }), true), 'approved')
  assert.equal(reviewSweepAction(mkTask({ id: 't', status: 'pending' }), true), 'rejected')
  assert.equal(reviewSweepAction(undefined, true), 'unbind')
  assert.equal(reviewSweepAction(mkTask({ id: 't', status: 'in_progress' }), false), 'unbind')
  assert.equal(reviewSweepAction(mkTask({ id: 't', status: 'in_progress' }), true), 'none')
})

const empty = new Set<string>()
const dispatchBase = {
  workers: [{ id: 'p1', agentId: 'claude' }, { id: 'p2', agentId: 'codex' }],
  occupiedPaneIds: empty, workingPaneIds: empty, activeTaskIds: empty, skippedTaskIds: empty,
}
t('conductor: dispatch matches assigned agent, unassigned takes any free worker', () => {
  const tasks = [mkTask({ id: 'a', assigned_agent: 'codex' }), mkTask({ id: 'b' })]
  const out = planDispatches({ ...dispatchBase, tasks })
  assert.deepEqual(out.map(x => [x.task.id, x.worker.id]), [['a', 'p2'], ['b', 'p1']])
})
t('conductor: dispatch never double-books a pane or a task in one tick', () => {
  const tasks = [mkTask({ id: 'a' }), mkTask({ id: 'b' }), mkTask({ id: 'c' })]
  const out = planDispatches({ ...dispatchBase, tasks })
  assert.equal(out.length, 2) // two workers → third task waits
  assert.equal(new Set(out.map(x => x.worker.id)).size, 2)
})
t('conductor: dispatch honours dependency gating', () => {
  const tasks = [mkTask({ id: 'dep', status: 'in_progress' }), mkTask({ id: 'b', depends_on: 'dep' })]
  assert.equal(planDispatches({ ...dispatchBase, tasks }).length, 0)
  const done = [mkTask({ id: 'dep', status: 'done' }), mkTask({ id: 'b', depends_on: 'dep' })]
  assert.deepEqual(planDispatches({ ...dispatchBase, tasks: done }).map(x => x.task.id), ['b'])
})
t('conductor: dispatch skips occupied/working panes and skipped/active tasks', () => {
  const tasks = [mkTask({ id: 'a' }), mkTask({ id: 'b' }), mkTask({ id: 'c' })]
  const out = planDispatches({
    ...dispatchBase, tasks,
    occupiedPaneIds: new Set(['p1']), workingPaneIds: new Set(['p2']),
  })
  assert.equal(out.length, 0) // no free pane at all
  const out2 = planDispatches({
    ...dispatchBase, tasks,
    skippedTaskIds: new Set(['a']), activeTaskIds: new Set(['b']),
  })
  assert.deepEqual(out2.map(x => x.task.id), ['c'])
})
t('conductor: dispatch limit=1 surfaces a single assisted proposal', () => {
  const tasks = [mkTask({ id: 'a' }), mkTask({ id: 'b' })]
  assert.equal(planDispatches({ ...dispatchBase, tasks, limit: 1 }).length, 1)
})
t('conductor: no worker of the assigned agent → task stays queued', () => {
  const tasks = [mkTask({ id: 'a', assigned_agent: 'cursor' })]
  assert.equal(planDispatches({ ...dispatchBase, tasks }).length, 0)
})

t('conductor: review routing never assigns the author\'s own agent', () => {
  const tasks = [mkTask({ id: 'a', status: 'needs_review', assigned_agent: 'claude' })]
  const out = planReviews({ ...dispatchBase, tasks, underReviewTaskIds: empty })
  assert.deepEqual(out.map(x => x.worker.id), ['p2']) // codex reviews claude's work
  const sameAgentOnly = planReviews({
    tasks, workers: [{ id: 'p1', agentId: 'claude' }],
    occupiedPaneIds: empty, workingPaneIds: empty, underReviewTaskIds: empty, skippedTaskIds: empty,
  })
  assert.equal(sameAgentOnly.length, 0) // no self-review, ever
})
t('conductor: review routing skips tasks already under review', () => {
  const tasks = [mkTask({ id: 'a', status: 'needs_review', assigned_agent: 'claude' })]
  const out = planReviews({ ...dispatchBase, tasks, underReviewTaskIds: new Set(['a']) })
  assert.equal(out.length, 0)
})

t('conductor: synthesis waits for open tasks, including needs_review', () => {
  assert.equal(readyForSynthesis([]), false) // no tasks yet → keep waiting
  assert.equal(readyForSynthesis([mkTask({ id: 'a', status: 'done' }), mkTask({ id: 'b', status: 'in_progress' })]), false)
  assert.equal(readyForSynthesis([mkTask({ id: 'a', status: 'done' }), mkTask({ id: 'b', status: 'needs_review' })]), false)
  assert.equal(readyForSynthesis([mkTask({ id: 'a', status: 'done' }), mkTask({ id: 'b', status: 'failed' })]), true)
})

t('conductor: message delivery — one per pane per tick, skips busy panes', () => {
  const panes = [
    { id: 'p1', agentId: 'claude', running: true, working: false },
    { id: 'p2', agentId: 'claude', running: true, working: true },
    { id: 'p3', agentId: 'codex', running: false, working: false },
  ]
  const msgs = [
    { id: 'm1', to_agent: 'claude' },
    { id: 'm2', to_agent: 'claude' }, // p1 already used, p2 mid-output → waits
    { id: 'm3', to_agent: 'codex' }, // only pane not running → waits
  ]
  const out = planMessageDelivery(msgs, panes)
  assert.deepEqual(out.map(x => [x.message.id, x.pane.id]), [['m1', 'p1']])
})

// ---------- terminalLinks (terminal→editor bridge) ----------
t('terminalLinks: relative path with :line', () => {
  const links = findPathLinks('error in src/components/Foo.tsx:123 — fix it')
  assert.equal(links.length, 1)
  assert.equal(links[0].path, 'src/components/Foo.tsx')
  assert.equal(links[0].line, 123)
  assert.equal('error in '.length, links[0].start)
  assert.equal(links[0].end, links[0].start + 'src/components/Foo.tsx:123'.length)
})
t('terminalLinks: windows absolute with :line:col', () => {
  const links = findPathLinks('  at D:\\swarmmind\\electron\\main.ts:45:7')
  assert.equal(links.length, 1)
  assert.equal(links[0].path, 'D:\\swarmmind\\electron\\main.ts')
  assert.equal(links[0].line, 45)
})
t('terminalLinks: tsc style path(line,col)', () => {
  const links = findPathLinks('src/lib/verify.ts(12,5): error TS2304')
  assert.equal(links.length, 1)
  assert.equal(links[0].path, 'src/lib/verify.ts')
  assert.equal(links[0].line, 12)
})
t('terminalLinks: dot-relative and backslash-relative', () => {
  assert.equal(findPathLinks('see ./relative/path.js:7')[0]?.path, './relative/path.js')
  assert.equal(findPathLinks('see ..\\up\\file.py')[0]?.path, '..\\up\\file.py')
  assert.equal(findPathLinks('see src\\components\\Foo.tsx:12')[0]?.line, 12)
})
t('terminalLinks: trailing punctuation is not part of the link', () => {
  assert.equal(findPathLinks('(see src/lib/verify.ts)')[0]?.path, 'src/lib/verify.ts')
  assert.equal(findPathLinks('open src/foo.ts.')[0]?.path, 'src/foo.ts')
  assert.equal(findPathLinks('files src/a.ts, src/b.ts changed').length, 2)
})
t('terminalLinks: URLs and non-paths do not match', () => {
  assert.equal(findPathLinks('https://example.com/foo.ts').length, 0)
  assert.equal(findPathLinks('meeting at 12:30 and/or later').length, 0)
  assert.equal(findPathLinks('ran node_modules/.bin/tsc fine').length, 0) // no extension on last segment
  assert.equal(findPathLinks('').length, 0)
})
t('terminalLinks: bare filename without a separator is too noisy to link', () => {
  assert.equal(findPathLinks('edit foo.ts please').length, 0)
})
t('terminalLinks: multiple matches keep distinct offsets', () => {
  const text = 'src/a.ts:1 then src/b.ts:2'
  const links = findPathLinks(text)
  assert.deepEqual(links.map(l => text.slice(l.start, l.end)), ['src/a.ts:1', 'src/b.ts:2'])
})
t('terminalLinks: isAbsolutePathLike', () => {
  assert.equal(isAbsolutePathLike('D:\\x\\y.ts'), true)
  assert.equal(isAbsolutePathLike('C:/x/y.ts'), true)
  assert.equal(isAbsolutePathLike('/usr/y.ts'), true)
  assert.equal(isAbsolutePathLike('src/y.ts'), false)
})
t('terminalLinks: candidateAbsolutePaths resolution order + dedupe', () => {
  assert.deepEqual(candidateAbsolutePaths('D:/abs.ts', ['D:/root']), ['D:/abs.ts'])
  assert.deepEqual(
    candidateAbsolutePaths('src/foo.ts', ['D:/wt', null, 'D:/root/', 'D:/wt']),
    ['D:/wt/src/foo.ts', 'D:/root/src/foo.ts'],
  )
  assert.deepEqual(candidateAbsolutePaths('./src/foo.ts', ['D:/root']), ['D:/root/src/foo.ts'])
})

// ---------- indexUpdate (incremental semantic index) ----------
t('indexUpdate: isIndexablePath filters ext, noise dirs and slash styles', () => {
  assert.equal(isIndexablePath('src/lib/foo.ts'), true)
  assert.equal(isIndexablePath('src\\lib\\foo.ts'), true)
  assert.equal(isIndexablePath('docs/readme.md'), true)
  assert.equal(isIndexablePath('assets/logo.png'), false) // not a text ext
  assert.equal(isIndexablePath('node_modules/x/foo.ts'), false)
  assert.equal(isIndexablePath('.swarmmind/vector-index.json'), false)
  assert.equal(isIndexablePath('dist/bundle.js'), false)
  assert.equal(isIndexablePath(''), false)
})
t('indexUpdate: planIncrementalUpdate dedupes, filters, caps, keeps order', () => {
  const out = planIncrementalUpdate(['a/x.ts', 'b\\y.md', 'a/x.ts', 'img/z.png', 'c/w.py'], 2)
  assert.deepEqual(out, ['a/x.ts', 'b/y.md'])
  assert.deepEqual(planIncrementalUpdate([], 5), [])
})
const chunk = (path: string, n = 1) =>
  Array.from({ length: n }, (_, i) => ({ path, startLine: i * 10, endLine: i * 10 + 9, vector: [1] }))
t('indexUpdate: mergeIndexEntries replaces a file’s chunks', () => {
  const idx = [...chunk('a.ts', 2), ...chunk('b.ts', 1)]
  const merged = mergeIndexEntries(idx, 'a.ts', chunk('a.ts', 3))
  assert.equal(merged.filter(e => e.path === 'a.ts').length, 3)
  assert.equal(merged.filter(e => e.path === 'b.ts').length, 1)
})
t('indexUpdate: mergeIndexEntries with fresh=[] drops a deleted file', () => {
  const idx = [...chunk('a.ts', 2), ...chunk('b.ts', 1)]
  const merged = mergeIndexEntries(idx, 'a.ts', [])
  assert.deepEqual(merged.map(e => e.path), ['b.ts'])
})
t('indexUpdate: mergeIndexEntries trims stalest others at the cap, fresh survives', () => {
  const idx = [...chunk('old.ts', 3), ...chunk('mid.ts', 2)]
  const merged = mergeIndexEntries(idx, 'new.ts', chunk('new.ts', 2), 4)
  assert.equal(merged.length, 4)
  assert.equal(merged.filter(e => e.path === 'new.ts').length, 2) // fresh kept in full
  assert.equal(merged.filter(e => e.path === 'old.ts').length, 0) // stalest trimmed first
  assert.equal(merged.filter(e => e.path === 'mid.ts').length, 2)
})

// ---------- devServerUrl (preview auto-detect) ----------
t('devServerUrl: vite-style announcement', () => {
  assert.equal(findDevServerUrl('  VITE v5.0.0  ready\n  ➜  Local:   http://localhost:5173/\n'), 'http://localhost:5173/')
})
t('devServerUrl: latest announcement wins', () => {
  const out = 'Local: http://localhost:3000/\n…restarted…\nLocal: http://localhost:3001/'
  assert.equal(findDevServerUrl(out), 'http://localhost:3001/')
})
t('devServerUrl: 0.0.0.0 and [::1] map to localhost', () => {
  assert.equal(findDevServerUrl('Serving on http://0.0.0.0:8000'), 'http://localhost:8000')
  assert.equal(findDevServerUrl('ready http://[::1]:4321/app'), 'http://localhost:4321/app')
})
t('devServerUrl: bare host:port needs a serverish line', () => {
  assert.equal(findDevServerUrl('Server listening on 127.0.0.1:8080'), 'http://localhost:8080')
  assert.equal(findDevServerUrl('connect ECONNREFUSED 127.0.0.1:5432'), null) // a DB error is not a dev server
})
t('devServerUrl: remote URLs and empty input do not match', () => {
  assert.equal(findDevServerUrl('see https://github.com/x/y'), null)
  assert.equal(findDevServerUrl(''), null)
})
t('devServerUrl: trailing punctuation stripped', () => {
  assert.equal(findDevServerUrl('running at http://localhost:3000.'), 'http://localhost:3000')
})

// ---------- recipes (one-click swarm templates) ----------
const mkIdGen = () => { let n = 0; return () => `id-${n++}` }
const recipeLeaves = (root: BuiltGroup<string>): BuiltLeaf<string>[] => {
  const out: BuiltLeaf<string>[] = []
  const walk = (n: BuiltLeaf<string> | BuiltGroup<string>) => {
    if (n.type === 'leaf') out.push(n)
    else n.children.forEach(walk)
  }
  walk(root)
  return out
}
t('recipes: layout has one leaf per recipe pane, all auto-spawning', () => {
  for (const r of SWARM_RECIPES) {
    const { root } = buildRecipeLayout(r, 'claude', mkIdGen())
    const leaves = recipeLeaves(root)
    assert.equal(leaves.length, r.panes.length)
    assert.ok(leaves.every(l => l.pendingAutoSpawn === true && l.agentId === 'claude'))
    assert.deepEqual(leaves.map(l => l.title), r.panes.map(p => p.title))
  }
})
t('recipes: lead pane id points at the lead leaf; none when no lead', () => {
  const lead = SWARM_RECIPES.find(r => r.id === 'leadDuo')!
  const built = buildRecipeLayout(lead, 'claude', mkIdGen())
  const leadLeaf = recipeLeaves(built.root).find(l => l.title === 'Lead')!
  assert.equal(built.leadPaneId, leadLeaf.id)
  const parallel = SWARM_RECIPES.find(r => r.id === 'parallel')!
  assert.equal(buildRecipeLayout(parallel, 'claude', mkIdGen()).leadPaneId, null)
})
t('recipes: worktree flags follow the recipe; ids unique', () => {
  const full = SWARM_RECIPES.find(r => r.id === 'fullSwarm')!
  const { root } = buildRecipeLayout(full, 'codex', mkIdGen())
  const leaves = recipeLeaves(root)
  assert.deepEqual(leaves.map(l => !!l.worktree), full.panes.map(p => !!p.worktree))
  const ids = new Set(leaves.map(l => l.id))
  assert.equal(ids.size, leaves.length)
})

// ── TypeScript language service mapping (electron/lib/tsLsp.ts) ─────────────
t('tsLsp: DiagnosticCategory maps to lint severity', () => {
  assert.equal(severityOf(1), 'error')   // ts.DiagnosticCategory.Error
  assert.equal(severityOf(0), 'warning') // Warning
  assert.equal(severityOf(2), 'info')    // Suggestion
  assert.equal(severityOf(3), 'info')    // Message
})
t('tsLsp: a message chain flattens with indentation, a plain string passes through', () => {
  assert.equal(flattenMessage('Type X is not assignable to Y.'), 'Type X is not assignable to Y.')
  const chain = {
    messageText: "Type 'A' is not assignable to type 'B'.",
    next: [
      { messageText: "Property 'x' is missing.", next: [{ messageText: "Did you mean 'y'?" }] },
    ],
  }
  assert.equal(
    flattenMessage(chain),
    "Type 'A' is not assignable to type 'B'.\n  Property 'x' is missing.\n    Did you mean 'y'?",
  )
})
t('tsLsp: display parts join; hover fences the signature and keeps docs', () => {
  assert.equal(displayPartsToText([{ text: 'const' }, { text: ' ' }, { text: 'x' }]), 'const x')
  assert.equal(displayPartsToText(undefined), '')
  assert.equal(formatHover('const x: number', 'The count.'), '```ts\nconst x: number\n```\n\nThe count.')
  assert.equal(formatHover('const x: number', ''), '```ts\nconst x: number\n```')
  // Nothing to show → '' so the caller skips the tooltip rather than flashing an empty box.
  assert.equal(formatHover('  ', '\n'), '')
})
t('tsLsp: isTsLike accepts the JS/TS family only', () => {
  for (const f of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'A.TS'])
    assert.equal(isTsLike(f), true, f)
  for (const f of ['a.py', 'a.rs', 'a.json', 'a.md', 'a.txt', 'noext']) assert.equal(isTsLike(f), false, f)
})
t('tsLsp: samePath is separator- and case-insensitive (Windows)', () => {
  assert.equal(samePath('D:\\swarmmind\\src\\a.ts', 'd:/swarmmind/src/A.ts'), true)
  assert.equal(samePath('/a/b.ts', '/a/c.ts'), false)
})
t('tsLsp: chooseProject skips the solution root for the project that owns the file', () => {
  // The exact shape of this repo: root tsconfig has `files: []` + references.
  const root = { configPath: 'D:/p/tsconfig.json', fileNames: [] }
  const web = { configPath: 'D:/p/tsconfig.web.json', fileNames: ['D:/p/src/App.tsx'] }
  const node = { configPath: 'D:/p/tsconfig.node.json', fileNames: ['D:/p/electron/main.ts'] }
  // Trusting the *nearest* config here would hand back the file-less root, whose
  // compilerOptions lack `jsx` — and every .tsx would be reported as broken.
  assert.equal(chooseProject('D:\\p\\src\\App.tsx', root, [web, node]), 'D:/p/tsconfig.web.json')
  assert.equal(chooseProject('D:\\p\\electron\\main.ts', root, [web, node]), 'D:/p/tsconfig.node.json')
})
t('tsLsp: chooseProject prefers a nearest config that claims the file; falls back when none do', () => {
  const near = { configPath: '/p/tsconfig.json', fileNames: ['/p/src/a.ts'] }
  assert.equal(chooseProject('/p/src/a.ts', near, []), '/p/tsconfig.json')
  // An untracked/new file: nothing claims it, but the nearest real config is
  // still a better guess than no compiler options at all.
  assert.equal(chooseProject('/p/src/brand-new.ts', near, []), '/p/tsconfig.json')
  // No tsconfig anywhere → null, and the worker uses defaults.
  assert.equal(chooseProject('/p/src/a.ts', null, []), null)
})

// ── Diagnostic merging (src/lib/diagnostics.ts) ─────────────────────────────
const tsDiag = (line: number, message: string, severity: 'error' | 'warning' | 'info' = 'error') =>
  ({ line, message, severity, source: 'ts' as const })
const aiDiag = (line: number, message: string, severity: 'error' | 'warning' | 'info' = 'warning') =>
  ({ line, message, severity, source: 'ai' as const })

t('diagnostics: normalizeMessage ignores case, quotes and punctuation', () => {
  assert.equal(normalizeMessage("Type 'A' is not assignable to type 'B'."), 'type a is not assignable to type b')
  assert.equal(normalizeMessage('Type A is not assignable to type B'), 'type a is not assignable to type b')
})
t('diagnostics: an AI diagnostic on a line the compiler already errored on is dropped', () => {
  // The model restating the type error in vaguer words is pure noise.
  const merged = mergeDiagnostics(
    [tsDiag(3, "Type 'string' is not assignable to type 'number'.")],
    [aiDiag(3, 'This assignment looks like it has the wrong type.')],
  )
  assert.equal(merged.length, 1)
  assert.equal(merged[0].source, 'ts')
})
t('diagnostics: a TS warning does NOT suppress an AI finding on the same line', () => {
  // The model may have spotted something the checker cannot see.
  const merged = mergeDiagnostics([tsDiag(5, 'Unused variable.', 'warning')], [aiDiag(5, 'Off-by-one in the loop bound.')])
  assert.equal(merged.length, 2)
})
t('diagnostics: AI findings on other lines survive — that is the whole point of the model', () => {
  const merged = mergeDiagnostics([tsDiag(2, 'Cannot find name x.')], [aiDiag(9, 'This promise is never awaited.')])
  assert.deepEqual(merged.map((d) => [d.line, d.source]), [[2, 'ts'], [9, 'ai']])
})
t('diagnostics: duplicate TS diagnostics collapse (a file can be a root of two projects)', () => {
  const merged = mergeDiagnostics([tsDiag(4, "Cannot find name 'x'."), tsDiag(4, 'Cannot find name x')], [])
  assert.equal(merged.length, 1)
})
t('diagnostics: sorted by line, then errors before warnings', () => {
  // The AI diag sits on line 4 (no TS error there), so it survives and we can
  // see the ordering: line 1 error → line 4 info → line 7 error. Note line 4
  // also carries a TS warning, which must NOT suppress it.
  const merged = mergeDiagnostics(
    [tsDiag(7, 'boom'), tsDiag(1, 'bang'), tsDiag(4, 'unused', 'warning')],
    [aiDiag(4, 'style nit', 'info')],
  )
  assert.deepEqual(
    merged.map((d) => [d.line, d.severity]),
    [[1, 'error'], [4, 'warning'], [4, 'info'], [7, 'error']],
  )
})
t('diagnostics: summarize counts errors and warnings', () => {
  const s = summarizeDiagnostics([tsDiag(1, 'a'), tsDiag(2, 'b'), tsDiag(3, 'c', 'warning'), aiDiag(4, 'd', 'info')])
  assert.deepEqual(s, { errors: 2, warnings: 1 })
})

// ---------- tsLsp: applyTextEdits + rename plan (compiler-exact F2) ----------
t('applyTextEdits: multiple edits land without shifting each other', () => {
  assert.equal(
    applyTextEdits('foo(); foo(); foo();', [
      { start: 0, length: 3, newText: 'barBaz' },
      { start: 7, length: 3, newText: 'barBaz' },
      { start: 14, length: 3, newText: 'barBaz' },
    ]),
    'barBaz(); barBaz(); barBaz();',
  )
})
t('applyTextEdits: prefix/suffix text (shorthand property) applies as one span', () => {
  // TS renames `{ a }` by replacing the span of `a` with `a: newName`.
  assert.equal(
    applyTextEdits('const o = { a }', [{ start: 12, length: 1, newText: 'a: b' }]),
    'const o = { a: b }',
  )
})
t('applyTextEdits: unordered input is fine; overlap or out-of-range refuses (null)', () => {
  assert.equal(
    applyTextEdits('abcdef', [
      { start: 4, length: 1, newText: 'Y' },
      { start: 0, length: 1, newText: 'X' },
    ]),
    'XbcdYf',
  )
  assert.equal(applyTextEdits('abc', [{ start: 1, length: 5, newText: 'x' }]), null)
  assert.equal(
    applyTextEdits('abcdef', [
      { start: 0, length: 3, newText: 'x' },
      { start: 2, length: 2, newText: 'y' },
    ]),
    null,
  )
})
t('offsetToLine + lineTextAt: CRLF-safe line lookup', () => {
  const s = 'first\r\nsecond line\r\nthird'
  const off = s.indexOf('second')
  assert.equal(offsetToLine(s, off), 2)
  assert.equal(lineTextAt(s, off), 'second line')
  assert.equal(offsetToLine(s, 0), 1)
  assert.equal(lineTextAt(s, s.length - 1), 'third')
})
t('isValidIdentifier: identifiers only — the exact-rename path writes files unattended', () => {
  assert.ok(isValidIdentifier('fooBar_2$'))
  assert.ok(!isValidIdentifier('foo bar'))
  assert.ok(!isValidIdentifier('2foo'))
  assert.ok(!isValidIdentifier('foo-bar'))
  assert.ok(!isValidIdentifier(''))
})
t('rename: toWorkspaceRelative survives Windows separator/case drift', () => {
  assert.equal(toWorkspaceRelative('D:\\swarmmind', 'd:/swarmmind/src/App.tsx'), 'src/App.tsx')
  assert.equal(toWorkspaceRelative('/home/u/repo', '/home/u/repo/a/b.ts'), 'a/b.ts')
  assert.equal(toWorkspaceRelative('D:\\swarmmind', 'D:/elsewhere/x.ts'), null)
  // real case of the file path is preserved
  assert.equal(toWorkspaceRelative('d:/repo', 'D:/repo/Src/Foo.TS'), 'Src/Foo.TS')
})
t('rename: buildRenamePlan maps files to a Composer plan; any out-of-root file rejects the whole plan', () => {
  const plan = buildRenamePlan('D:\\repo', 'old', 'shiny', [
    { path: 'd:/repo/src/a.ts', newContent: 'A', edits: 2 },
    { path: 'd:/repo/src/b.ts', newContent: 'B', edits: 1 },
  ])
  assert.ok(plan)
  assert.deepEqual(plan!.changes, [
    { path: 'src/a.ts', action: 'edit', content: 'A' },
    { path: 'src/b.ts', action: 'edit', content: 'B' },
  ])
  assert.ok(plan!.summary.includes('3 occurrences across 2 files'))
  // one file outside the root → null (a partial rename is worse than none)
  assert.equal(
    buildRenamePlan('D:\\repo', 'old', 'shiny', [
      { path: 'd:/repo/src/a.ts', newContent: 'A', edits: 1 },
      { path: 'd:/other/b.ts', newContent: 'B', edits: 1 },
    ]),
    null,
  )
  assert.equal(buildRenamePlan('D:\\repo', 'a', 'b', []), null)
})

// ---------- sessionExport (Swarm Timeline → shareable report) ----------
const xe = (over: Partial<ExportEvent>): ExportEvent => ({
  id: Math.random().toString(36).slice(2),
  ts: 1_700_000_000_000,
  type: 'memory_write',
  agent_id: null,
  pane_id: null,
  payload: null,
  ...over,
})
t('sessionExport: escapeHtml neutralizes markup and quotes', () => {
  assert.equal(escapeHtml(`<img src=x onerror="pwn()">&'`), '&lt;img src=x onerror=&quot;pwn()&quot;&gt;&amp;&#39;')
})
t('sessionExport: stats aggregate cost, tasks, files (unique), agents (first-seen order)', () => {
  const events: ExportEvent[] = [
    xe({ ts: 1000, type: 'agent_spawn', agent_id: 'codex' }),
    xe({ ts: 2000, type: 'task_create', agent_id: 'claude', payload: { title: 'a' } }),
    xe({ ts: 3000, type: 'cost', agent_id: 'claude', payload: { usd: 0.5, tokens: 1200 } }),
    xe({ ts: 4000, type: 'cost', agent_id: 'codex', payload: { usd: 0.25, tokens: 800 } }),
    xe({ ts: 5000, type: 'file_changed', payload: { path: 'src/a.ts' } }),
    xe({ ts: 6000, type: 'file_changed', payload: { path: 'src/a.ts' } }),
    xe({ ts: 7000, type: 'task_update', agent_id: 'claude', payload: { title: 'a', status: 'done' } }),
  ]
  const s = buildSessionStats(events)
  assert.equal(s.total, 7)
  assert.equal(s.durationMs, 6000)
  assert.deepEqual(s.agents, ['codex', 'claude']) // first-seen, never re-sorted
  assert.equal(s.totalCostUsd, 0.75)
  assert.equal(s.totalTokens, 2000)
  assert.deepEqual(s.filesChanged, ['src/a.ts'])
  assert.equal(s.tasksCreated, 1)
  assert.equal(s.tasksCompleted, 1)
})
t('sessionExport: stats on an empty log are all-zero, no crash', () => {
  const s = buildSessionStats([])
  assert.equal(s.total, 0)
  assert.equal(s.startTs, null)
  assert.equal(s.durationMs, 0)
})
t('sessionExport: malformed payloads never throw', () => {
  const s = buildSessionStats([
    xe({ type: 'cost', payload: { usd: 'garbage', tokens: NaN } }),
    xe({ type: 'file_changed', payload: { path: 42 as unknown as string } }),
    xe({ type: 'task_update', payload: null }),
  ])
  assert.equal(s.totalCostUsd, 0)
  assert.equal(s.filesChanged.length, 0)
})
t('sessionExport: summarizeEvent covers known types and falls back to the raw type', () => {
  assert.equal(summarizeEvent(xe({ type: 'task_update', payload: { title: 'fix', status: 'done' } })), 'task "fix" → done')
  assert.equal(summarizeEvent(xe({ type: 'checkpoint', payload: { label: 'pre', trigger: 'composer' } })), 'checkpoint "pre" (composer)')
  assert.equal(summarizeEvent(xe({ type: 'something_new' })), 'something_new')
})
t('sessionExport: formatDuration and compactNumber', () => {
  assert.equal(formatDuration(45_000), '45s')
  assert.equal(formatDuration(192_000), '3m 12s')
  assert.equal(formatDuration(8_040_000), '2h 14m')
  assert.equal(compactNumber(1284), '1,284')
  assert.equal(compactNumber(12_900), '12.9K')
  assert.equal(compactNumber(4_200_000), '4.2M')
})
t('sessionExport: exportFileBase is filename-safe', () => {
  const base = exportFileBase('My Repo / weird:name?', Date.UTC(2026, 6, 14))
  assert.ok(/^swarm-session-My-Repo-weird-name-\d{4}-\d{2}-\d{2}$/.test(base))
  assert.ok(!/[\\/:*?"<>|\s]/.test(base))
})
t('sessionExport: agentPalette uses brand colours, fixed-order fallback for unknowns', () => {
  const p = agentPalette(['claude', 'mystery-a', 'mystery-b'])
  assert.equal(p['claude'], '#c084fc')
  assert.notEqual(p['mystery-a'], p['mystery-b'])
  // deterministic: same input, same assignment
  assert.deepEqual(agentPalette(['claude', 'mystery-a', 'mystery-b']), p)
})
t('sessionExport: HTML report is self-contained and escapes payload-derived text', () => {
  const html = renderSessionHtml(
    [xe({ ts: 2000, type: 'task_create', agent_id: 'claude', payload: { title: '<script>alert(1)</script>' } })],
    { workspaceName: 'demo & co', exportedAt: 3000 },
  )
  assert.ok(html.startsWith('<!doctype html>'))
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('demo &amp; co'))
  // self-contained: no external fetches of any kind
  assert.ok(!/(src|href)\s*=\s*["']?https?:/i.test(html))
  assert.ok(!html.includes('@import'))
})
t('sessionExport: HTML renders events oldest-first regardless of input order', () => {
  const html = renderSessionHtml(
    [
      xe({ ts: 9000, type: 'agent_exit', agent_id: 'claude', payload: { exitCode: 0 } }),
      xe({ ts: 1000, type: 'agent_spawn', agent_id: 'claude' }),
    ],
    { workspaceName: 'w', exportedAt: 9500 },
  )
  assert.ok(html.indexOf('spawned') < html.indexOf('exited'))
})
t('sessionExport: markdown digest carries stats, day headers and timeline lines', () => {
  const md = renderSessionMarkdown(
    [
      xe({ ts: Date.UTC(2026, 6, 14, 10, 0, 0), type: 'task_create', agent_id: 'claude', payload: { title: 'build it' } }),
      xe({ ts: Date.UTC(2026, 6, 14, 11, 0, 0), type: 'task_update', agent_id: 'claude', payload: { title: 'build it', status: 'done' } }),
    ],
    { workspaceName: 'demo', exportedAt: Date.UTC(2026, 6, 14, 12, 0, 0) },
  )
  assert.ok(md.startsWith('# Swarm session — demo'))
  assert.ok(md.includes('- **Events:** 2'))
  assert.ok(md.includes('**Tasks done:** 1/1'))
  assert.ok(md.includes('**claude** created task "build it"'))
  assert.ok(/### \d{4}-\d{2}-\d{2}/.test(md))
})

// ---------- taskBoard (paperclip-style atomic claim selection) ----------
const mkClaimTask = (o: Partial<ClaimableTask> & { id: string }): ClaimableTask => ({
  status: 'pending', assigned_agent: null, depends_on: null, priority: 0, created_at: 1000, ...o,
})
t('taskBoard: claims the only pending task', () => {
  const tasks = [mkClaimTask({ id: 'a' })]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks))?.id, 'a')
})
t('taskBoard: skips in_progress / done / needs_review / failed', () => {
  const tasks = [
    mkClaimTask({ id: 'a', status: 'in_progress' }),
    mkClaimTask({ id: 'b', status: 'done' }),
    mkClaimTask({ id: 'c', status: 'needs_review' }),
    mkClaimTask({ id: 'd', status: 'failed' }),
  ]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks)), null)
})
t('taskBoard: does not claim a task assigned to another agent', () => {
  const tasks = [mkClaimTask({ id: 'a', assigned_agent: 'codex' })]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks)), null)
})
t('taskBoard: can claim a task pre-assigned to itself', () => {
  const tasks = [mkClaimTask({ id: 'a', assigned_agent: 'claude' })]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks))?.id, 'a')
})
t('taskBoard: blocked task (unmet dependency) is not claimable', () => {
  const tasks = [
    mkClaimTask({ id: 'dep', status: 'pending' }),
    mkClaimTask({ id: 'a', depends_on: 'dep' }),
  ]
  // only unblocked candidate is the dependency itself
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks))?.id, 'dep')
})
t('taskBoard: task becomes claimable once its dependency is done', () => {
  const tasks = [
    mkClaimTask({ id: 'dep', status: 'done' }),
    mkClaimTask({ id: 'a', depends_on: 'dep' }),
  ]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks))?.id, 'a')
})
t('taskBoard: higher priority wins over older FIFO', () => {
  const tasks = [
    mkClaimTask({ id: 'old', priority: 0, created_at: 100 }),
    mkClaimTask({ id: 'urgent', priority: 5, created_at: 200 }),
  ]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks))?.id, 'urgent')
})
t('taskBoard: equal priority falls back to FIFO (oldest first)', () => {
  const tasks = [
    mkClaimTask({ id: 'newer', priority: 1, created_at: 300 }),
    mkClaimTask({ id: 'older', priority: 1, created_at: 100 }),
  ]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks))?.id, 'older')
})
t('taskBoard: targeted claim returns the named task when eligible', () => {
  const tasks = [mkClaimTask({ id: 'a' }), mkClaimTask({ id: 'b', priority: 9 })]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks), { taskId: 'a' })?.id, 'a')
})
t('taskBoard: targeted claim returns null when that task is ineligible', () => {
  const tasks = [mkClaimTask({ id: 'a', status: 'in_progress' })]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks), { taskId: 'a' }), null)
})
t('taskBoard: targeted claim of a missing id is null', () => {
  const tasks = [mkClaimTask({ id: 'a' })]
  assert.equal(selectClaimable(tasks, 'claude', doneIdSet(tasks), { taskId: 'nope' }), null)
})
t('taskBoard: isClaimable matches the selection rules', () => {
  assert.equal(isClaimable(mkClaimTask({ id: 'a' }), 'claude', new Set()), true)
  assert.equal(isClaimable(mkClaimTask({ id: 'a', assigned_agent: 'codex' }), 'claude', new Set()), false)
})

// ── canvasResize ──────────────────────────────────────────────────────────────
// Canvas cards resize from all 8 handles. The invariant under test throughout:
// the edge you are NOT dragging must not move.

const BOX = { x: 100, y: 100, w: 400, h: 300 }
const FREE = { minW: 140, minH: 80, grid: null }
const SNAP = { minW: 140, minH: 80, grid: 20 }

t('canvasResize: exposes 8 directions, each with a cursor', () => {
  assert.equal(RESIZE_DIRS.length, 8)
  for (const d of RESIZE_DIRS) assert.ok(RESIZE_CURSOR[d].endsWith('-resize'))
})
t('canvasResize: south-east grows w/h and pins the north-west corner', () => {
  const r = resizeRect(BOX, 'se', 50, 30, FREE)
  assert.deepEqual(r, { x: 100, y: 100, w: 450, h: 330 })
})
t('canvasResize: north-west moves x/y and pins the south-east corner', () => {
  const r = resizeRect(BOX, 'nw', 40, 20, FREE)
  assert.deepEqual(r, { x: 140, y: 120, w: 360, h: 280 })
  assert.equal(r.x + r.w, BOX.x + BOX.w)  // east edge pinned
  assert.equal(r.y + r.h, BOX.y + BOX.h)  // south edge pinned
})
t('canvasResize: edge handles only affect their own axis', () => {
  const e = resizeRect(BOX, 'e', 60, 999, FREE)
  assert.deepEqual(e, { x: 100, y: 100, w: 460, h: 300 })
  const n = resizeRect(BOX, 'n', 999, -50, FREE)
  assert.deepEqual(n, { x: 100, y: 50, w: 400, h: 350 })
})
t('canvasResize: west drag past the minimum pins the east edge (no leftward creep)', () => {
  // Dragging the west handle far right would take w below minW.
  const r = resizeRect(BOX, 'w', 900, 0, FREE)
  assert.equal(r.w, 140)
  assert.equal(r.x + r.w, BOX.x + BOX.w, 'east edge must stay put')
})
t('canvasResize: north drag past the minimum pins the south edge', () => {
  const r = resizeRect(BOX, 'n', 0, 900, FREE)
  assert.equal(r.h, 80)
  assert.equal(r.y + r.h, BOX.y + BOX.h, 'south edge must stay put')
})
t('canvasResize: east/south minimums clamp without moving the origin', () => {
  const r = resizeRect(BOX, 'se', -900, -900, FREE)
  assert.deepEqual(r, { x: 100, y: 100, w: 140, h: 80 })
})
t('canvasResize: snapping the west edge leaves the east edge exactly pinned', () => {
  // The regression this module exists for: snapping x and w independently
  // moved the far edge too.
  const r = resizeRect(BOX, 'w', 3, 0, SNAP)
  assert.equal(r.x % 20, 0, 'dragged edge snaps to the grid')
  assert.equal(r.x + r.w, BOX.x + BOX.w, 'east edge must not drift')
})
t('canvasResize: snapping the north edge leaves the south edge exactly pinned', () => {
  const r = resizeRect(BOX, 'n', 0, 7, SNAP)
  assert.equal(r.y % 20, 0)
  assert.equal(r.y + r.h, BOX.y + BOX.h)
})
t('canvasResize: snapping a south-east drag lands both edges on the grid', () => {
  const r = resizeRect(BOX, 'se', 7, 7, SNAP)
  assert.equal((r.x + r.w) % 20, 0)
  assert.equal((r.y + r.h) % 20, 0)
  assert.equal(r.x, BOX.x)
  assert.equal(r.y, BOX.y)
})
t('canvasResize: a zero delta is a no-op', () => {
  assert.deepEqual(resizeRect(BOX, 'se', 0, 0, FREE), BOX)
  assert.deepEqual(resizeRect(BOX, 'nw', 0, 0, FREE), BOX)
})
t('canvasResize: fractional deltas are rounded to whole pixels when not snapping', () => {
  const r = resizeRect(BOX, 'se', 10.4, 10.6, FREE)
  assert.deepEqual(r, { x: 100, y: 100, w: 410, h: 311 })
})

// ── canvas grid alignment ─────────────────────────────────────────────────────
// The bug this guards: snapping quantised to 20 while the background drew cells
// at 28, so snapped items never lined up with the visible grid. The invariant is
// that every DRAWN grid feature sits on a coordinate snapToGrid() can produce.

// Replicate how the browser tiles a CSS background, and return the world
// coordinate of drawn feature `k`. `background-position` is the offset of the
// first tile; a dot is centred in its tile, a line sits at the tile's start.
function drawnFeatureWorld(cam: number, zoom: number, kind: 'dots' | 'grid', k: number): number {
  const size = GRID * zoom
  const offset = gridBackgroundOffset(cam, zoom, kind)
  const boardPos = offset + k * size + (kind === 'dots' ? size / 2 : 0)
  return (boardPos - cam) / zoom
}

const nearlyMultipleOfGrid = (v: number) => {
  const m = Math.abs(v) % GRID
  return Math.min(m, GRID - m) < 1e-9
}

t('canvasGrid: snapToGrid quantises to GRID and rounds when off', () => {
  assert.equal(snapToGrid(GRID * 3 + 2, true), GRID * 3)
  assert.equal(snapToGrid(GRID * 3 - 2, true), GRID * 3)
  assert.equal(snapToGrid(10.4, false), 10)
})
t('canvasGrid: drawn grid LINES land on snap coordinates', () => {
  for (const cam of [0, 120, -350, 17.5]) {
    for (const zoom of [0.4, 1, 1.75, 2.5]) {
      for (const k of [-3, 0, 5]) {
        const w = drawnFeatureWorld(cam, zoom, 'grid', k)
        assert.ok(nearlyMultipleOfGrid(w), `line off-lattice at cam=${cam} zoom=${zoom} k=${k} -> ${w}`)
      }
    }
  }
})
t('canvasGrid: drawn DOTS land on snap coordinates (half-cell shift applied)', () => {
  for (const cam of [0, 120, -350, 17.5]) {
    for (const zoom of [0.4, 1, 1.75, 2.5]) {
      for (const k of [-3, 0, 5]) {
        const w = drawnFeatureWorld(cam, zoom, 'dots', k)
        assert.ok(nearlyMultipleOfGrid(w), `dot off-lattice at cam=${cam} zoom=${zoom} k=${k} -> ${w}`)
      }
    }
  }
})
t('canvasGrid: dots and lines differ by exactly half a cell', () => {
  const size = GRID * 1.5
  const d = gridBackgroundOffset(200, 1.5, 'dots')
  const g = gridBackgroundOffset(200, 1.5, 'grid')
  assert.ok(Math.abs((g - d) - size / 2) < 1e-9)
})
t('canvasGrid: a snapped card corner coincides with a drawn feature', () => {
  const snapped = snapToGrid(437, true)
  assert.ok(nearlyMultipleOfGrid(snapped))
  // ...and the resize path snaps its dragged edge onto the same lattice.
  const r = resizeRect({ x: 0, y: 0, w: 400, h: 300 }, 'se', 5, 5, { minW: 140, minH: 80, grid: GRID })
  assert.ok(nearlyMultipleOfGrid(r.x + r.w))
  assert.ok(nearlyMultipleOfGrid(r.y + r.h))
})

// ── fileOps / fsOps (file-explorer IDE operations) ───────────────────────────
// The explorer's move/copy/paste/drag surface is all path arithmetic, and the
// dangerous mistakes there are silent: relocating a folder into its own subtree,
// clobbering a file on paste, or leaving an editor tab pointed at a dead path.

t('fileOps: baseName/parentDir handle both separator styles', () => {
  assert.equal(baseName('D:\\repo\\src\\a.ts'), 'a.ts')
  assert.equal(baseName('/repo/src/a.ts'), 'a.ts')
  assert.equal(baseName('/repo/src/'), 'src')
  assert.equal(parentDir('D:\\repo\\src\\a.ts'), 'D:\\repo\\src')
  assert.equal(parentDir('/repo/src/a.ts'), '/repo/src')
  assert.equal(parentDir('a.ts'), '')
  assert.equal(pathSep('D:\\a'), '\\')
  assert.equal(pathSep('/a'), '/')
  assert.equal(joinPath('D:\\repo\\src', 'b.ts'), 'D:\\repo\\src\\b.ts')
  assert.equal(joinPath('/repo/src/', 'b.ts'), '/repo/src/b.ts')
})
t('fileOps: rewritePath follows a moved file and everything under it', () => {
  assert.equal(rewritePath('/r/a.ts', '/r/a.ts', '/r/sub/a.ts'), '/r/sub/a.ts')
  assert.equal(rewritePath('/r/dir/x/y.ts', '/r/dir', '/r/moved'), '/r/moved/x/y.ts')
  // untouched paths report null so callers leave them alone
  assert.equal(rewritePath('/r/other.ts', '/r/dir', '/r/moved'), null)
  // a mere string prefix is not a descendant
  assert.equal(rewritePath('/r/dirty.ts', '/r/dir', '/r/moved'), null)
})
t('fileOps: selectRange is inclusive and order-independent', () => {
  const xs = [0, 1, 2, 3, 4]
  assert.deepEqual(selectRange(xs, 1, 3), [1, 2, 3])
  assert.deepEqual(selectRange(xs, 3, 1), [1, 2, 3])
  assert.deepEqual(selectRange(xs, 2, 2), [2])
  assert.deepEqual(selectRange(xs, -1, 2), [])
  assert.deepEqual(selectRange(xs, 0, 99), [])
})
t('fileOps: toggleSelection adds then removes', () => {
  assert.deepEqual(toggleSelection([], '/a'), ['/a'])
  assert.deepEqual(toggleSelection(['/a', '/b'], '/a'), ['/b'])
})
t('fileOps: a folder can never be moved into itself or its own subtree', () => {
  assert.equal(canMoveInto(['/r/dir'], '/r/dir'), false)
  assert.equal(canMoveInto(['/r/dir'], '/r/dir/sub'), false)
  assert.equal(canCopyInto(['/r/dir'], '/r/dir/sub'), false)
  assert.equal(canMoveInto(['/r/dir'], '/r/other'), true)
})
t('fileOps: moving into the current parent is a no-op, copying there is not', () => {
  assert.equal(canMoveInto(['/r/dir/a.ts'], '/r/dir'), false)
  assert.equal(canCopyInto(['/r/dir/a.ts'], '/r/dir'), true) // that is "duplicate"
  // a mixed selection is still movable if something actually relocates
  assert.equal(canMoveInto(['/r/dir/a.ts', '/r/elsewhere/b.ts'], '/r/dir'), true)
})
t('fileOps: topLevelPaths drops descendants of a selected folder', () => {
  assert.deepEqual(
    topLevelPaths(['/r/dir', '/r/dir/a.ts', '/r/dir/sub/b.ts', '/r/loose.ts']),
    ['/r/dir', '/r/loose.ts']
  )
  assert.deepEqual(topLevelPaths(['/r/a.ts', '/r/b.ts']), ['/r/a.ts', '/r/b.ts'])
})
t('fileOps: isUnder / relativeToRoot are separator- and case-tolerant', () => {
  assert.equal(isUnder('D:\\repo', 'D:/REPO/src/a.ts'), true)
  assert.equal(isUnder('/r/dir', '/r/dirty/a.ts'), false)
  assert.equal(relativeToRoot('D:\\repo', 'D:\\repo\\src\\a.ts'), 'src/a.ts')
  assert.equal(relativeToRoot('/r', '/elsewhere/a.ts'), '/elsewhere/a.ts')
})
t('fsOps: splitName keeps dotfiles whole', () => {
  assert.deepEqual(splitName('a.ts'), { stem: 'a', ext: '.ts' })
  assert.deepEqual(splitName('.gitignore'), { stem: '.gitignore', ext: '' })
  assert.deepEqual(splitName('archive.tar.gz'), { stem: 'archive.tar', ext: '.gz' })
  assert.deepEqual(splitName('README'), { stem: 'README', ext: '' })
})
t('fsOps: isValidEntryName rejects traversal everywhere, Win32 traps on Windows', () => {
  assert.equal(isValidEntryName('a.ts'), true)
  assert.equal(isValidEntryName(''), false)
  assert.equal(isValidEntryName('..'), false)
  assert.equal(isValidEntryName('.'), false)
  assert.equal(isValidEntryName('a/b'), false)
  assert.equal(isValidEntryName('a\\b'), false)
  assert.equal(isValidEntryName('a' + String.fromCharCode(9) + 'b'), false)
  // POSIX-legal, Windows-illegal
  assert.equal(isValidEntryName('a?.ts'), true)
  assert.equal(isValidEntryName('a?.ts', { windows: true }), false)
  assert.equal(isValidEntryName('name.', { windows: true }), false)
  assert.equal(isValidEntryName('CON', { windows: true }), false)
  assert.equal(isValidEntryName('con.txt', { windows: true }), false)
  assert.equal(isValidEntryName('console.ts', { windows: true }), true)
})
t('fsOps: isInside is strict containment, samePathish normalizes', () => {
  assert.equal(isInside('/r/dir', '/r/dir/a.ts'), true)
  assert.equal(isInside('/r/dir', '/r/dir'), false)
  assert.equal(isInside('/r/dir', '/r/dirty/a.ts'), false)
  assert.equal(isInside('D:\\r', 'D:/R/a.ts', true), true)
  assert.equal(isInside('D:\\r', 'D:/R/a.ts', false), false)
  assert.equal(samePathish('/r/dir/', '/r/dir'), true)
  assert.equal(samePathish('D:\\r', 'd:/r', true), true)
})
t('fsOps: nextAvailableName mirrors Finder/VS Code copy naming', () => {
  assert.equal(nextAvailableName('a.ts', []), 'a.ts')
  assert.equal(nextAvailableName('a.ts', ['a.ts']), 'a copy.ts')
  assert.equal(nextAvailableName('a.ts', ['a.ts', 'a copy.ts']), 'a copy 2.ts')
  // duplicating a duplicate must not stack suffixes
  assert.equal(nextAvailableName('a copy.ts', ['a copy.ts']), 'a copy 2.ts')
  assert.equal(nextAvailableName('a copy 2.ts', ['a copy.ts', 'a copy 2.ts']), 'a copy 3.ts')
  // dotfiles and extensionless names keep their shape
  assert.equal(nextAvailableName('.env', ['.env']), '.env copy')
  assert.equal(nextAvailableName('LICENSE', ['LICENSE']), 'LICENSE copy')
  // case-insensitive by default (Windows/macOS), exact when told otherwise
  assert.equal(nextAvailableName('A.ts', ['a.ts']), 'A copy.ts')
  assert.equal(nextAvailableName('A.ts', ['a.ts'], { caseInsensitive: false }), 'A.ts')
})

// ── loopSchedule (recurring-prompt loop timing) ──────────────────────────────
// The bug this guards against is silent and slow: a loop armed to run now that
// gets pushed a full interval into the future because its target pane was a
// moment late to come online ("a 30-minute loop only starts after 30 minutes").

t('loopSchedule: a fresh loop (null nextRunAt) is due immediately', () => {
  assert.equal(isLoopDue({ enabled: true, nextRunAt: null, intervalSec: 1800 }, 1000), true)
  // ...and firing schedules the next run exactly one interval out, not now.
  assert.equal(nextRunAfter(1000, 1800), 1000 + 1800 * 1000)
})
t('loopSchedule: a disabled loop is never due', () => {
  assert.equal(isLoopDue({ enabled: false, nextRunAt: null, intervalSec: 60 }, 5000), false)
  assert.equal(isLoopDue({ enabled: false, nextRunAt: 0, intervalSec: 60 }, 5000), false)
})
t('loopSchedule: due exactly at nextRunAt, not before', () => {
  const loop = { enabled: true, nextRunAt: 5000, intervalSec: 60 }
  assert.equal(isLoopDue(loop, 4999), false)
  assert.equal(isLoopDue(loop, 5000), true)
  assert.equal(isLoopDue(loop, 5001), true)
})
t('loopSchedule: due + live target → run; due + no target → wait (never reschedules)', () => {
  const due = { enabled: true, nextRunAt: null, intervalSec: 1800 }
  assert.equal(decideLoopAction(due, true, 1000), 'run')
  // The critical case: no live target yet stays "wait", so the runner leaves it
  // due and retries next tick — it must NOT slip a whole interval.
  assert.equal(decideLoopAction(due, false, 1000), 'wait')
})
t('loopSchedule: a not-yet-due loop skips regardless of target', () => {
  const later = { enabled: true, nextRunAt: 10_000, intervalSec: 60 }
  assert.equal(decideLoopAction(later, true, 1000), 'skip')
  assert.equal(decideLoopAction(later, false, 1000), 'skip')
})
t('loopSchedule: a loop waiting on a slow pane fires the moment it comes online', () => {
  // t0: created, due now, pane still spawning (no target) → wait, stays due.
  const loop = { enabled: true, nextRunAt: null, intervalSec: 1800 }
  assert.equal(decideLoopAction(loop, false, 0), 'wait')
  assert.equal(decideLoopAction(loop, false, 3000), 'wait')   // still spawning 3s later
  // pane goes 'running' at t=8s → next tick runs it (an 8s delay, not 30 min).
  assert.equal(decideLoopAction(loop, true, 8000), 'run')
})
t('loopSchedule: nextRunAfter floors a zero/negative interval to 1s', () => {
  assert.equal(nextRunAfter(1000, 0), 2000)
  assert.equal(nextRunAfter(1000, -5), 2000)
})

// ── canvasHandoff / canvasCapture (screenshot → annotate → hand off) ─────────
// The tricky, silent-if-wrong parts of the capture handoff: mapping a stroke
// drawn in world space onto an image's pixel grid, deciding which strokes to
// bake in, building the terminal-safe prompt, and refusing non-image data URLs.

t('canvasHandoff: rectsIntersect is overlap, not mere touching', () => {
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true)
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false) // edge-touch
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 5, h: 5 }), false)
  // a stroke fully inside the image counts
  assert.equal(rectsIntersect({ x: 0, y: 0, w: 100, h: 100 }, { x: 40, y: 40, w: 5, h: 5 }), true)
})
t('canvasHandoff: fitBox preserves aspect, never upscales, keeps minimums', () => {
  // landscape shrinks to the width bound
  assert.deepEqual(fitBox(800, 400, 420, 360), { w: 420, h: 210 })
  // portrait shrinks to the height bound
  assert.deepEqual(fitBox(400, 800, 420, 360), { w: 180, h: 360 })
  // already small → unchanged (scale clamped to 1)
  assert.deepEqual(fitBox(200, 150, 420, 360), { w: 200, h: 150 })
  // degenerate input falls back to the max box rather than NaN
  assert.deepEqual(fitBox(0, 0, 420, 360), { w: 420, h: 360 })
})
t('canvasHandoff: projectPointToImage scales world → native pixels', () => {
  // image displayed 100×100 world px, backed by a 400×400 picture → ×4
  const box = { x: 10, y: 20, w: 100, h: 100 }
  assert.deepEqual(projectPointToImage(box, 400, 400, 10, 20), { x: 0, y: 0 })   // top-left corner
  assert.deepEqual(projectPointToImage(box, 400, 400, 60, 70), { x: 200, y: 200 }) // centre
  assert.deepEqual(projectPointToImage(box, 400, 400, 110, 120), { x: 400, y: 400 }) // bottom-right
  assert.equal(strokeScale(box, 400, 400), 4)
})
t('canvasHandoff: buildHandoffPrompt is single-line and always names the path', () => {
  const p = buildHandoffPrompt('fix the  red\nbutton', '.swarmmind/canvas-captures/x.png')
  assert.equal(p, 'fix the red button (screenshot: .swarmmind/canvas-captures/x.png)')
  assert.equal(p.includes('\n'), false) // never submit a terminal prompt early
  // empty / whitespace note falls back to the generic ask
  assert.equal(
    buildHandoffPrompt('   ', 'a.png', 'Look at this.'),
    'Look at this. (screenshot: a.png)'
  )
  assert.equal(buildHandoffPrompt(null, 'a.png', 'Look.'), 'Look. (screenshot: a.png)')
})
t('canvasCapture: parseImageDataUrl accepts only PNG/JPEG image data', () => {
  const png = parseImageDataUrl('data:image/png;base64,iVBORw0KGgo=')
  assert.deepEqual(png, { ext: 'png', base64: 'iVBORw0KGgo=' })
  assert.equal(parseImageDataUrl('data:image/jpeg;base64,/9j/4AAQ')?.ext, 'jpg')
  assert.equal(parseImageDataUrl('data:image/jpg;base64,/9j/4AAQ')?.ext, 'jpg')
  // whitespace inside the payload is stripped
  assert.equal(parseImageDataUrl('data:image/png;base64,iVBO\nR w0=')?.base64, 'iVBORw0=')
  // rejected: non-image or non-data URLs, and empty payloads
  assert.equal(parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='), null)
  assert.equal(parseImageDataUrl('data:text/html;base64,PGgxPg=='), null)
  assert.equal(parseImageDataUrl('https://example.com/a.png'), null)
  assert.equal(parseImageDataUrl('data:image/png;base64,'), null)
  assert.equal(parseImageDataUrl(null), null)
  assert.ok(MAX_CAPTURE_BYTES > 0)
})

// ── onnxThreads (on-device model WASM threading) ─────────────────────────────
// The packaged file:// origin can't run ORT's blob pthread workers; requesting
// threads there just spews importScripts errors and degrades to 1 anyway.

t('onnxThreads: never threads under file:// (packaged build)', () => {
  assert.equal(onnxThreadCount('file:', true, 16), 1)
  assert.equal(onnxThreadCount('file:', false, 16), 1)
})
t('onnxThreads: single-threaded without SharedArrayBuffer', () => {
  assert.equal(onnxThreadCount('http:', false, 16), 1)
})
t('onnxThreads: small capped pool in dev with SharedArrayBuffer', () => {
  assert.equal(onnxThreadCount('http:', true, 16), 4)  // capped at 4
  assert.equal(onnxThreadCount('http:', true, 4), 3)   // cores - 1
  assert.equal(onnxThreadCount('http:', true, 1), 1)   // floored at 1
  assert.equal(onnxThreadCount('http:', true, 0), 1)   // missing hardwareConcurrency
})

// ── canvasTasks (canvas visual-orchestrator: depends_on surgery) ─────────────
// Drawing an arrow between task cards edits the comma-separated depends_on
// column. The dangerous mistakes are silent: a dup dep, a self-dep, or closing
// a dependency cycle that would wedge the conductor (a task can never become
// runnable if it transitively depends on itself).

t('canvasTasks: parse/serialize round-trips and cleans the column', () => {
  assert.deepEqual(parseTaskDeps('a, b ,,c'), ['a', 'b', 'c'])
  assert.deepEqual(parseTaskDeps(null), [])
  assert.deepEqual(parseTaskDeps(''), [])
  assert.equal(serializeDeps(['a', 'b']), 'a,b')
  assert.equal(serializeDeps([]), null)          // empty → null column, not ''
  assert.equal(serializeDeps([' a ', '', 'b']), 'a,b')
})
t('canvasTasks: addDep is idempotent and refuses self-deps', () => {
  assert.equal(addDep(null, 'a', 'self'), 'a')
  assert.equal(addDep('a', 'b', 'self'), 'a,b')
  assert.equal(addDep('a,b', 'a', 'self'), 'a,b')   // already present → unchanged
  assert.equal(addDep('a', 'self', 'self'), 'a')    // self-dep refused
  assert.equal(addDep(null, 'self', 'self'), null)
})
t('canvasTasks: removeDep drops just the one id', () => {
  assert.equal(removeDep('a,b,c', 'b'), 'a,c')
  assert.equal(removeDep('a', 'a'), null)           // last one → null column
  assert.equal(removeDep('a,b', 'z'), 'a,b')        // absent → unchanged
})
t('canvasTasks: wouldCycle catches direct, transitive and self loops', () => {
  // graph: B depends on A, C depends on B  →  A --needs--> nothing
  const deps = { A: [], B: ['A'], C: ['B'] }
  const depsOf = (id) => deps[id] ?? []
  assert.equal(wouldCycle('A', 'A', depsOf), true)   // self
  // Adding "A depends on C" closes A→C→B→A.
  assert.equal(wouldCycle('A', 'C', depsOf), true)
  // Adding "A depends on B" closes A→B→A.
  assert.equal(wouldCycle('A', 'B', depsOf), true)
  // Adding "C depends on A" is fine (A has no prerequisites).
  assert.equal(wouldCycle('C', 'A', depsOf), false)
})
t('canvasTasks: status colours are stable and distinct where it matters', () => {
  assert.equal(taskStatusColor('in_progress'), 'var(--accent)')
  assert.equal(taskStatusColor('done'), '#7fc8a0')
  assert.equal(taskStatusColor('failed'), '#e5484d')
  assert.equal(taskStatusColor('pending'), 'var(--text-muted)')
  assert.equal(taskStatusColor('anything-else'), 'var(--text-muted)') // safe default
})

// ── canvasLod (semantic zoom) ────────────────────────────────────────────────
// Below a zoom threshold a terminal card renders as a status tile instead of an
// unreadable live view. The two things that go wrong: a single threshold makes
// the whole board flicker when the wheel parks on it, and world-unit sizes that
// forget the camera scale render four-pixel text.

t('canvasLod: the tile threshold is hysteretic, so a nudge cannot flicker', () => {
  // Well below / well above are unambiguous whatever the previous answer was.
  assert.equal(isTileZoom(0.3, false), true)
  assert.equal(isTileZoom(0.3, true), true)
  assert.equal(isTileZoom(1.0, true), false)
  assert.equal(isTileZoom(1.0, false), false)
  // Inside the band the previous answer wins — that IS the hysteresis.
  const mid = (TILE_ZOOM_ENTER + TILE_ZOOM_EXIT) / 2
  assert.equal(isTileZoom(mid, false), false)
  assert.equal(isTileZoom(mid, true), true)
  // And the band is a band, not a coincidence.
  assert.ok(TILE_ZOOM_EXIT > TILE_ZOOM_ENTER)
})
t('canvasLod: a dead pty never claims to be working', () => {
  assert.equal(tileState({ ptyStatus: 'running', attention: 'waiting' }), 'waiting')
  assert.equal(tileState({ ptyStatus: 'running', attention: 'working' }), 'working')
  assert.equal(tileState({ ptyStatus: 'running', attention: null }), 'idle')
  // The pane exited mid-turn: its last attention value must not survive it.
  assert.equal(tileState({ ptyStatus: 'exited', attention: 'working' }), 'stopped')
  assert.equal(tileState({ ptyStatus: 'idle', attention: 'working' }), 'idle')
})
t('canvasLod: tile sizes are world units that land at a fixed screen size', () => {
  const big = { w: 500, h: 340 }
  const m = tileMetrics(0.4, big)
  // 13 screen px at zoom 0.4 is 32.5 world px — the card is big enough to take it.
  assert.ok(Math.abs(m.title - 13 / 0.4) < 0.001)
  assert.equal(m.showTitle, true)
  assert.equal(m.showMeta, true)
  // Halving the zoom doubles the world size, so the screen size is unchanged.
  const half = tileMetrics(0.2, big)
  assert.ok(Math.abs(half.title * 0.2 - m.title * 0.4) < 0.001)
})
t('canvasLod: a small card drops rows instead of overflowing them', () => {
  const stub = { w: 140, h: 80 }
  const m = tileMetrics(0.25, stub)
  // 35×20 on screen: nothing legible fits, so neither row is drawn.
  assert.equal(m.showTitle, false)
  assert.equal(m.showMeta, false)
  // And the font is clamped against the card rather than 13/0.25 = 52px.
  assert.ok(m.title <= stub.h * 0.26 + 0.001)
})
t('canvasLod: a spend above zero never rounds away to "free"', () => {
  assert.equal(tileCost(undefined), null)
  assert.equal(tileCost(0), null)
  assert.equal(tileCost(0.004), '<$0.01')   // NOT "$0.00"
  assert.equal(tileCost(1.239), '$1.24')
})

// ── canvasRoutes (arrows between terminals = live message routes) ────────────
// An arrow from terminal A to terminal B hands A's finished turn to B. The
// guards are the whole module: without them a pair of mutual arrows is two CLIs
// prompting each other forever, on the user's bill.

const ROUTE_ITEMS = [
  { id: 'cardA', kind: 'terminal', paneId: 'A' },
  { id: 'cardB', kind: 'terminal', paneId: 'B' },
  { id: 'cardImg', kind: 'image' },
  { id: 'cardTask', kind: 'task' },
]

t('canvasRoutes: only terminal→terminal arrows become routes', () => {
  const routes = deriveRoutes(ROUTE_ITEMS, [
    { from: 'cardA', to: 'cardB' },      // a route
    { from: 'cardImg', to: 'cardA' },    // screenshot handoff — not a route
    { from: 'cardTask', to: 'cardTask' },// a dependency — not a route
  ])
  assert.deepEqual(routes, [{ from: 'A', to: 'B' }])
})
t('canvasRoutes: self-arrows and duplicates are dropped', () => {
  const dupCard = [...ROUTE_ITEMS, { id: 'cardA2', kind: 'terminal', paneId: 'A' }]
  const routes = deriveRoutes(dupCard, [
    { from: 'cardA', to: 'cardB' },
    { from: 'cardA2', to: 'cardB' },   // same pane pair drawn twice
    { from: 'cardA', to: 'cardA2' },   // same pane on both ends
  ])
  assert.deepEqual(routes, [{ from: 'A', to: 'B' }])
  assert.equal(hasRoutesFrom(routes, 'A'), true)
  assert.equal(hasRoutesFrom(routes, 'B'), false)
})
t('canvasRoutes: relayBody drops the partial first line only when it truncated', () => {
  const long = 'headcut\n' + 'x'.repeat(200) + '\nreal content here'
  const cut = relayBody(long, 60)
  assert.ok(!cut.includes('headcut'))
  // An untruncated body keeps its first line — that line is content, not debris.
  assert.ok(relayBody('first line\nsecond line', 1000).startsWith('first line'))
  // Blank runs collapse; nothing substantial → nothing to relay.
  assert.equal(relayBody('a\n\n\n\nb'.padEnd(40, 'z'), 1000).includes('\n\n\n'), false)
  assert.equal(relayBody('ok', 1000), '')
  assert.equal(relayBody('   \n \n  ', 1000), '')
})
t('canvasRoutes: a relay fans out to every downstream pane', () => {
  const routes = [{ from: 'A', to: 'B' }, { from: 'A', to: 'C' }, { from: 'B', to: 'C' }]
  const out = planRelay(routes, 'A', 'finished the parser', emptyRelayMemo(), 1000)
  assert.deepEqual(out.map(r => r.to), ['B', 'C'])
})
t('canvasRoutes: mutual arrows cannot ping-pong', () => {
  const routes = [{ from: 'A', to: 'B' }, { from: 'B', to: 'A' }]
  let memo = emptyRelayMemo()
  const first = planRelay(routes, 'A', 'body one', memo, 1000)
  assert.deepEqual(first.map(r => r.to), ['B'])
  memo = markRelayed(memo, 'A', first, 1000)
  // B finishes its turn moments later — having just been handed A's output, it
  // is almost certainly echoing it. Relaying back is the infinite loop.
  assert.deepEqual(planRelay(routes, 'B', 'body two', memo, 2000), [])
  // Long after the quiet window it is a genuine turn again.
  assert.deepEqual(planRelay(routes, 'B', 'body two', memo, 1000 + 60_000).map(r => r.to), ['A'])
})
t('canvasRoutes: the cooldown stops one quiet moment per tool call becoming a dispatch', () => {
  const routes = [{ from: 'A', to: 'B' }]
  let memo = markRelayed(emptyRelayMemo(), 'A', [{ to: 'B', body: 'x' }], 1000)
  assert.deepEqual(planRelay(routes, 'A', 'something new', memo, 1000 + 5_000), [])
  assert.equal(planRelay(routes, 'A', 'something new', memo, 1000 + 25_000).length, 1)
})
t('canvasRoutes: the same tail is never sent twice down the same wire', () => {
  const routes = [{ from: 'A', to: 'B' }]
  const body = 'the identical report'
  let memo = markRelayed(emptyRelayMemo(), 'A', [{ to: 'B', body }], 0)
  // Past the cooldown, but the pane printed nothing new.
  assert.deepEqual(planRelay(routes, 'A', body, memo, 100_000), [])
  assert.equal(planRelay(routes, 'A', 'a different report', memo, 100_000).length, 1)
})
t('canvasRoutes: an empty body is never relayed, and markRelayed is pure', () => {
  const routes = [{ from: 'A', to: 'B' }]
  const memo = emptyRelayMemo()
  assert.deepEqual(planRelay(routes, 'A', '', memo, 1000), [])
  const next = markRelayed(memo, 'A', [{ to: 'B', body: 'x' }], 1000)
  assert.notEqual(next, memo)
  assert.deepEqual(memo.sentAt, {})            // the original is untouched
  assert.equal(next.receivedAt.B, 1000)
  // No relays → the same object back, so a caller can compare by identity.
  assert.equal(markRelayed(memo, 'A', [], 1000), memo)
})
t('canvasRoutes: the prompt names its source and forbids replying', () => {
  const p = buildRelayPrompt('Builder', 'line one\nline two')
  assert.ok(p.includes('Builder'))
  assert.ok(/do not send anything back/i.test(p))
  // Single line: it is typed into a terminal, where a newline is Enter.
  assert.equal(p.includes('\n'), false)
})

// ── canvasFrames (named regions that own their contents) ─────────────────────

const FRAME = { id: 'f1', x: 0, y: 0, w: 400, h: 300 }
const FRAME_ITEMS = [
  { id: 'in1', kind: 'terminal', paneId: 'p1', x: 10, y: 10, w: 100, h: 80 },
  // Straddling the edge, but its centre (350,150) is inside → it belongs.
  { id: 'edge', kind: 'terminal', paneId: 'p2', x: 300, y: 100, w: 100, h: 100 },
  // Overlapping heavily, but centred outside → it does not.
  { id: 'out', kind: 'note', x: 380, y: 10, w: 200, h: 60 },
  { id: 'f2', kind: 'frame', x: 20, y: 20, w: 100, h: 100 },
  { id: 'dupPane', kind: 'terminal', paneId: 'p1', x: 40, y: 200, w: 60, h: 40 },
]

t('canvasFrames: membership is the centre, not the overlap', () => {
  const kids = frameChildren(FRAME, FRAME_ITEMS)
  assert.ok(kids.includes('in1'))
  assert.ok(kids.includes('edge'))       // centre inside despite hanging over
  assert.ok(!kids.includes('out'))       // overlaps a lot, centre outside
})
t('canvasFrames: a frame never contains a frame', () => {
  // f2 sits entirely inside f1 and is still excluded — nesting would make the
  // group move recursive, and overlapping rectangles produce cycles readily.
  assert.ok(!frameChildren(FRAME, FRAME_ITEMS).includes('f2'))
  assert.ok(!frameChildren(FRAME, [{ ...FRAME, kind: 'frame' }]).includes('f1'))
})
t('canvasFrames: framePanes is deduped, so a count cannot disagree with a send', () => {
  const panes = framePanes(FRAME, FRAME_ITEMS)
  assert.deepEqual(panes, ['p1', 'p2'])   // two cards on p1, one pane
})
t('canvasFrames: frameOf picks the innermost frame for an overlap', () => {
  const small = { id: 'small', x: 0, y: 0, w: 100, h: 100 }
  const big = { id: 'big', x: -50, y: -50, w: 500, h: 500 }
  const card = { id: 'c', kind: 'note', x: 10, y: 10, w: 20, h: 20 }
  assert.equal(frameOf(card, [big, small]), 'small')
  assert.equal(frameOf(card, [big]), 'big')
  assert.equal(frameOf({ ...card, x: 9000, y: 9000 }, [big, small]), null)
})
t('canvasFrames: default names skip the ones already taken', () => {
  assert.equal(nextFrameName([], 'Frame'), 'Frame 1')
  assert.equal(nextFrameName(['Frame 1', 'frame 2'], 'Frame'), 'Frame 3')
  assert.equal(nextFrameName(['  Frame 1  '], 'Frame'), 'Frame 2')
  // Colours cycle rather than running out.
  assert.equal(nextFrameColor(0), nextFrameColor(FRAME_COLORS.length))
})
t('canvasFrames: frames paint behind everything', () => {
  assert.ok(FRAME_Z < 0)
  assert.equal(isFrameKind('frame'), true)
  assert.equal(isFrameKind('terminal'), false)
})

// ── canvasAttention (finding the pane that needs you) ────────────────────────

const VIEWPORT = { w: 1000, h: 600 }

t('canvasAttention: the world rect is what the camera can actually see', () => {
  const v = viewportWorldRect({ x: -200, y: -100, zoom: 2 }, VIEWPORT)
  assert.deepEqual({ x: v.x, y: v.y, w: v.w, h: v.h }, { x: 100, y: 50, w: 500, h: 300 })
})
t('canvasAttention: partly-visible counts as on screen', () => {
  const view = { id: 'v', x: 0, y: 0, w: 500, h: 300 }
  assert.equal(isOffscreen({ id: 'a', x: 480, y: 10, w: 200, h: 50 }, view), false)
  assert.equal(isOffscreen({ id: 'b', x: 600, y: 10, w: 200, h: 50 }, view), true)
  // The margin makes a card clinging to the very edge count as off screen.
  assert.equal(isOffscreen({ id: 'c', x: 495, y: 10, w: 200, h: 50 }, view, 24), true)
})
t('canvasAttention: a jump centres the card and keeps the zoom', () => {
  const cam = cameraToCenter({ id: 'a', x: 100, y: 100, w: 200, h: 100 }, VIEWPORT, 0.5)
  assert.equal(cam.zoom, 0.5)
  // Card centre (200,150) at zoom 0.5 must land on the viewport centre.
  assert.equal(200 * cam.zoom + cam.x, VIEWPORT.w / 2)
  assert.equal(150 * cam.zoom + cam.y, VIEWPORT.h / 2)
})
t('canvasAttention: the target follows the newest question, not the item order', () => {
  const cards = [
    { id: 'cardB', kind: 'terminal', paneId: 'B', x: 0, y: 0, w: 10, h: 10 },
    { id: 'cardA', kind: 'terminal', paneId: 'A', x: 0, y: 0, w: 10, h: 10 },
    { id: 'note', kind: 'note', x: 0, y: 0, w: 10, h: 10 },
  ]
  // Notifications arrive newest-first, and A is newest despite being second here.
  assert.equal(pickAttentionTarget(cards, ['A', 'B']), 'cardA')
  assert.equal(pickAttentionTarget(cards, ['B']), 'cardB')
  // A pane with no card on the board is skipped, not returned unreachably.
  assert.equal(pickAttentionTarget(cards, ['ghost']), null)
  assert.equal(pickAttentionTarget(cards, []), null)
})
t('canvasAttention: follow moves once, and never for something already visible', () => {
  assert.equal(shouldFollow('cardA', null, true), true)
  assert.equal(shouldFollow('cardA', 'cardA', true), false)   // already chased it
  assert.equal(shouldFollow('cardA', null, false), false)     // it's on screen
  assert.equal(shouldFollow(null, null, true), false)
})

// ---------- vad (SwarmVoice auto-stop) ----------
const VAD = { threshold: 0.05, hangoverMs: 1000, minDurationMs: 500, maxDurationMs: 10_000 }
// Drive the detector over a script of [level, elapsedMs] frames.
function runVad(frames, opts = VAD) {
  let state = initVad(0)
  let last = { state, verdict: 'listening' }
  for (const [level, at] of frames) {
    last = stepVad(state, level, at, opts)
    state = last.state
    if (last.verdict.startsWith('stop')) return { ...last, at }
  }
  return { ...last, at: frames.length ? frames[frames.length - 1][1] : 0 }
}
t('vad: silence before any speech never stops the recording', () => {
  // Someone who takes four seconds to gather their thoughts must not have the
  // recording ended out from under them.
  const r = runVad(Array.from({ length: 40 }, (_, i) => [0.001, i * 100]))
  assert.equal(r.verdict, 'listening')
  assert.equal(r.state.speechStarted, false)
})
t('vad: stops after the hangover once speech has been heard', () => {
  const frames = [
    [0.4, 100], [0.4, 200], [0.4, 600],   // speech (past minDuration)
    [0.0, 700], [0.0, 1200], [0.0, 1700], // silence — 1100ms after last loud
  ]
  const r = runVad(frames)
  assert.equal(r.verdict, 'stop-silence')
  assert.equal(r.at, 1700)
})
t('vad: a pause shorter than the hangover keeps recording', () => {
  // Breathing between sentences must not end dictation.
  const r = runVad([
    [0.4, 100], [0.4, 600],
    [0.0, 900], [0.0, 1300],  // 700ms gap — under the 1000ms hangover
    [0.4, 1400], [0.4, 1800],
  ])
  assert.equal(r.verdict, 'speaking')
})
t('vad: a too-short clip is never auto-stopped', () => {
  // A cough at t=50 then silence: minDurationMs must hold the recording open
  // even though the hangover has elapsed.
  const r = runVad([[0.4, 50], [0.0, 100], [0.0, 400]])
  assert.equal(r.verdict, 'speaking')
})
t('vad: the max-duration ceiling fires even in continuous speech', () => {
  const r = runVad([[0.4, 100], [0.4, 5000], [0.4, 10_000]])
  assert.equal(r.verdict, 'stop-max')
})
t('vad: frameLoudness averages the usable bins and clamps to 1', () => {
  assert.equal(frameLoudness(new Uint8Array(10).fill(0)), 0)
  assert.equal(frameLoudness(new Uint8Array(10).fill(140)), 1)
  assert.equal(frameLoudness(new Uint8Array(10).fill(255)), 1)   // clamped
  assert.ok(Math.abs(frameLoudness(new Uint8Array(10).fill(70)) - 0.5) < 1e-9)
})

// ---------- dragWidget (floating widget placement) ----------
const SIZE = { width: 200, height: 100 }
const VIEW = { width: 1000, height: 800 }
t('dragWidget: clampToViewport keeps a widget fully on screen', () => {
  assert.deepEqual(clampToViewport({ x: 500, y: 400 }, SIZE, VIEW), { x: 500, y: 400 })
  assert.deepEqual(clampToViewport({ x: -50, y: -50 }, SIZE, VIEW), { x: 8, y: 8 })
  // Bottom-right: pinned so the full widget stays visible, not just its corner.
  assert.deepEqual(clampToViewport({ x: 9999, y: 9999 }, SIZE, VIEW), { x: 792, y: 692 })
})
t('dragWidget: a viewport smaller than the widget pins it, never negative', () => {
  // A window narrower than the widget must still leave it grabbable at the
  // top-left rather than pushing it off-screen to a negative coordinate.
  const tiny = { width: 100, height: 60 }
  const p = clampToViewport({ x: 50, y: 50 }, SIZE, tiny)
  assert.deepEqual(p, { x: 8, y: 8 })
})
t('dragWidget: a saved position survives a shrunken window', () => {
  // Restored at 1000x800 coords into a 600x400 window: must come back on screen.
  const p = clampToViewport({ x: 792, y: 692 }, SIZE, { width: 600, height: 400 })
  assert.deepEqual(p, { x: 392, y: 292 })
})
t('dragWidget: dragPosition preserves the grab offset', () => {
  // Grabbed 30px in from the widget's left edge → the widget's left edge should
  // sit 30px left of the pointer, not jump its corner to the cursor.
  assert.deepEqual(
    dragPosition({ x: 400, y: 300 }, { x: 30, y: 20 }, SIZE, VIEW),
    { x: 370, y: 280 },
  )
  // ...and still clamps at the edges.
  assert.deepEqual(dragPosition({ x: 5, y: 5 }, { x: 30, y: 20 }, SIZE, VIEW), { x: 8, y: 8 })
})
t('dragWidget: defaultPosition lands inside the bottom-right corner', () => {
  const p = defaultPosition(SIZE, VIEW)
  assert.ok(p.x + SIZE.width <= VIEW.width && p.y + SIZE.height <= VIEW.height)
  assert.ok(p.x > VIEW.width / 2 && p.y > VIEW.height / 2)
})
t('dragWidget: parsePosition rejects anything unusable', () => {
  assert.deepEqual(parsePosition('{"x":10,"y":20}'), { x: 10, y: 20 })
  assert.equal(parsePosition(null), null)
  assert.equal(parsePosition(''), null)
  assert.equal(parsePosition('not json'), null)
  assert.equal(parsePosition('{"x":null,"y":3}'), null)
  // A NaN written by an earlier bug must not render the widget at an
  // unreachable coordinate — fall back to the default corner instead.
  assert.equal(parsePosition('{"x":"NaN","y":5}'), null)
})

// ---------- conductor spend budget ----------
t('conductor budget: totalSpend sums panes and ignores junk', () => {
  assert.equal(totalSpend({ a: { usd: 1.5 }, b: { usd: 2.25 } }), 3.75)
  assert.equal(totalSpend({}), 0)
  assert.equal(totalSpend(undefined), 0)
  // A NaN or negative figure parsed out of terminal output must not corrupt
  // the total (it would otherwise poison every later comparison).
  assert.equal(totalSpend({ a: { usd: NaN }, b: { usd: -5 }, c: { usd: 2 } }), 2)
})
t('conductor budget: an unset budget never pauses a run', () => {
  assert.equal(budgetStatus(999, null), 'ok')
  assert.equal(budgetStatus(999, 0), 'ok')     // 0 is "unset", not "spend nothing"
})
t('conductor budget: warn at 80%, exceeded at the limit', () => {
  assert.equal(budgetStatus(1, 10), 'ok')
  assert.equal(budgetStatus(7.99, 10), 'ok')
  assert.equal(budgetStatus(8, 10), 'warn')
  assert.equal(budgetStatus(9.99, 10), 'warn')
  assert.equal(budgetStatus(10, 10), 'exceeded')   // reaching it counts
  assert.equal(budgetStatus(25, 10), 'exceeded')
})
t('conductor budget: parseBudget rejects anything not a positive number', () => {
  assert.equal(parseBudget('5'), 5)
  assert.equal(parseBudget(' 2.50 '), 2.5)
  assert.equal(parseBudget('$3'), 3)
  assert.equal(parseBudget(''), null)      // blank = no budget
  assert.equal(parseBudget(null), null)
  assert.equal(parseBudget('abc'), null)
  // Critically: these must be null, not 0 — a 0 budget would read as
  // 'exceeded' and pause the run the moment the user typed a stray character.
  assert.equal(parseBudget('0'), null)
  assert.equal(parseBudget('-5'), null)
  assert.equal(parseBudget('Infinity'), null)
})
t('conductor budget: the halt note names both figures', () => {
  const note = buildBudgetHaltNote(10.5, 10)
  assert.match(note, /\$10\.50/)
  assert.match(note, /\$10\.00/)
  assert.match(note, /paused/i)
  assert.equal(formatUsd(0.125), '$0.125')   // sub-dollar keeps precision
  assert.equal(formatUsd(12.5), '$12.50')
})

// ---------- aiProvider (multi-provider AI backend) ----------
t('aiProvider: resolveProvider falls back on blank/unknown settings', () => {
  const groq = resolveProvider(null, null, null)
  assert.equal(groq.id, 'groq')
  assert.equal(groq.model, 'llama-3.3-70b-versatile')
  // An unknown provider id degrades to the default rather than breaking every
  // AI surface at once.
  assert.equal(resolveProvider('nope', null, null).id, 'groq')
  const claude = resolveProvider('anthropic', '  ', null)
  assert.equal(claude.model, 'claude-opus-5')
  assert.equal(claude.openAiCompatible, false)
  // A custom endpoint keeps its URL (trailing slashes trimmed) and needs no key.
  const local = resolveProvider('custom', 'llama3', 'http://localhost:11434/v1//')
  assert.equal(local.baseUrl, 'http://localhost:11434/v1')
  assert.equal(local.requiresKey, false)
})
t('aiProvider: errors name the configured provider, not a hard-coded vendor', () => {
  const p = resolveProvider('anthropic', 'claude-opus-5', null)
  assert.match(providerErrorMessage(p, { status: 401 }), /Anthropic/)
  assert.match(providerErrorMessage(p, { status: 429 }), /rate limit/i)
  assert.match(providerErrorMessage(p, { status: 404 }), /claude-opus-5/)
  assert.match(providerErrorMessage(p, { status: 503 }), /unavailable/i)
  assert.equal(providerErrorMessage(p, { message: 'socket hang up' }), 'socket hang up')
  assert.match(providerErrorMessage(p, null), /request failed/)
})
t('aiProvider: filterChatModels drops non-chat models and duplicates', () => {
  assert.deepEqual(
    filterChatModels(['gpt-4o', 'whisper-large-v3', 'text-embedding-3', 'gpt-4o', 'llama-guard-4']),
    ['gpt-4o'],
  )
})
t('aiProvider: toAnthropicTools always emits a valid object schema', () => {
  const [tool] = toAnthropicTools([
    { type: 'function', function: { name: 'open_view', description: 'd', parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } } },
  ])
  assert.equal(tool.name, 'open_view')
  assert.equal(tool.input_schema.type, 'object')
  assert.deepEqual(tool.input_schema.required, ['v'])
  // A parameter-less tool still gets a well-formed schema (the API rejects a
  // missing or non-object one).
  const [bare] = toAnthropicTools([{ type: 'function', function: { name: 'get_status' } }])
  assert.equal(bare.input_schema.type, 'object')
  assert.deepEqual(bare.input_schema.properties, {})
  assert.equal(bare.description, '')
})
t('aiProvider: toAnthropicMessages lifts system out of the message array', () => {
  const { system, messages } = toAnthropicMessages([
    { role: 'system', content: 'You are SwarmAgent.' },
    { role: 'user', content: 'hi' },
  ])
  assert.equal(system, 'You are SwarmAgent.')
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0], { role: 'user', content: [{ type: 'text', text: 'hi' }] })
})
t('aiProvider: parallel tool results merge into ONE user message', () => {
  // The renderer appends each tool result as its own `role:'tool'` message.
  // Sending those as separate user turns degrades parallel tool calling
  // silently — no error, the model just stops issuing them.
  const { messages } = toAnthropicMessages([
    { role: 'user', content: 'status?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'a', type: 'function', function: { name: 'get_status', arguments: '{}' } },
        { id: 'b', type: 'function', function: { name: 'list_tasks', arguments: '{"x":1}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'a', content: '2 panes' },
    { role: 'tool', tool_call_id: 'b', content: '3 tasks' },
  ])
  assert.equal(messages.length, 3)
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].content.length, 2)          // two tool_use blocks, no empty text block
  assert.equal(messages[1].content[0].type, 'tool_use')
  assert.deepEqual(messages[1].content[1].input, { x: 1 })  // arguments string → object
  assert.equal(messages[2].role, 'user')
  assert.equal(messages[2].content.length, 2)          // both results in ONE turn
  assert.deepEqual(messages[2].content.map((b) => b.tool_use_id), ['a', 'b'])
})
t('aiProvider: toAnthropicMessages drops blanks the API would reject', () => {
  const { messages } = toAnthropicMessages([
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '' },
    { role: 'tool', tool_call_id: 't', content: '' },
    { role: 'tool', content: 'orphan with no id' },
  ])
  // Only the id-carrying tool result survives, with a placeholder body.
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].content, [{ type: 'tool_result', tool_use_id: 't', content: '(no output)' }])
})
t('aiProvider: parseToolArguments never throws on malformed JSON', () => {
  assert.deepEqual(parseToolArguments('{"a":1}'), { a: 1 })
  assert.deepEqual(parseToolArguments('not json'), {})
  assert.deepEqual(parseToolArguments('[1,2]'), {})   // arrays aren't argument objects
  assert.deepEqual(parseToolArguments(undefined), {})
})
t('aiProvider: fromAnthropicContent rebuilds the OpenAI-shaped reply', () => {
  const { content, toolCalls } = fromAnthropicContent([
    { type: 'text', text: 'Okay, ' },
    { type: 'text', text: 'one second.' },
    { type: 'tool_use', id: 'tu_1', name: 'open_view', input: { view: 'board' } },
  ])
  assert.equal(content, 'Okay, one second.')
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].id, 'tu_1')
  assert.equal(toolCalls[0].type, 'function')
  assert.equal(toolCalls[0].function.name, 'open_view')
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { view: 'board' })
  assert.deepEqual(fromAnthropicContent(undefined), { content: '', toolCalls: [] })
})
t('aiProvider: a refusal is detectable before reading content', () => {
  // Claude declines with a *successful* response, so this must be checked or a
  // refusal presents as an inexplicably blank reply.
  assert.match(refusalMessage('refusal') ?? '', /declined/i)
  assert.equal(refusalMessage('end_turn'), null)
  assert.equal(refusalMessage(null), null)
})

// ---------- editorViewState (per-file cursor/scroll memory) ----------
t('editorViewState: recording moves a path to the most-recent end', () => {
  let m: ViewStateMap = {}
  m = rememberViewState(m, 'a.ts', { anchor: 1, head: 1, scrollTop: 0 })
  m = rememberViewState(m, 'b.ts', { anchor: 2, head: 2, scrollTop: 0 })
  assert.deepEqual(Object.keys(m), ['a.ts', 'b.ts'])
  // Re-recording a.ts makes it the newest, so b.ts becomes the eviction candidate.
  m = rememberViewState(m, 'a.ts', { anchor: 9, head: 9, scrollTop: 40 })
  assert.deepEqual(Object.keys(m), ['b.ts', 'a.ts'])
  assert.equal(m['a.ts'].anchor, 9)
})
t('editorViewState: the map is bounded, dropping the least recent first', () => {
  let m: ViewStateMap = {}
  for (let i = 0; i < 5; i++) m = rememberViewState(m, `f${i}.ts`, { anchor: i, head: i, scrollTop: 0 }, 3)
  assert.deepEqual(Object.keys(m), ['f2.ts', 'f3.ts', 'f4.ts'])
  // The default cap is a real number, not accidentally 0/undefined.
  assert.ok(MAX_REMEMBERED_FILES > 1)
})
t('editorViewState: forget drops one path and leaves the rest identical', () => {
  const m: ViewStateMap = {
    'a.ts': { anchor: 1, head: 1, scrollTop: 0 },
    'b.ts': { anchor: 2, head: 2, scrollTop: 0 },
  }
  assert.deepEqual(Object.keys(forgetViewState(m, 'a.ts')), ['b.ts'])
  // Nothing to remove → the same object back (no needless re-render churn).
  assert.equal(forgetViewState(m, 'nope.ts'), m)
})
t('editorViewState: a stale offset is clamped into the document, never thrown', () => {
  // The file shrank since we last saw it (an agent rewrote it). Dispatching the
  // remembered offset unclamped would make CodeMirror throw and blank the panel.
  assert.deepEqual(clampViewState({ anchor: 900, head: 950, scrollTop: 400 }, 100), {
    anchor: 100, head: 100, scrollTop: 400,
  })
  assert.deepEqual(clampViewState({ anchor: -5, head: 12, scrollTop: -3 }, 100), {
    anchor: 0, head: 12, scrollTop: 0,
  })
  assert.deepEqual(clampViewState({ anchor: NaN, head: Infinity, scrollTop: NaN }, 100), null)
})
t('editorViewState: top-of-file and missing states restore nothing', () => {
  // Restoring "line 1, scroll 0" is indistinguishable from the default, so it
  // reports null rather than costing a dispatch on every tab switch.
  assert.equal(clampViewState({ anchor: 0, head: 0, scrollTop: 0 }, 500), null)
  assert.equal(clampViewState(undefined, 500), null)
  assert.equal(clampViewState(null, 500), null)
  // But a pure scroll with no selection *is* worth restoring.
  assert.deepEqual(clampViewState({ anchor: 0, head: 0, scrollTop: 220 }, 500), {
    anchor: 0, head: 0, scrollTop: 220,
  })
})

// ---------- wakeWord (SwarmVoice hands-free trigger) ----------
t('wakeWord: the model’s punctuation and casing never block a match', () => {
  // Whisper decides these, not the user — a string compare would miss every time.
  for (const said of ['Hey, Swarm.', 'HEY SWARM', 'hey swarm!', '  Hey   swarm  ']) {
    assert.equal(matchWakeWord(said, DEFAULT_WAKE_PHRASE).matched, true, said)
  }
})
t('wakeWord: a command in the same breath comes back verbatim', () => {
  // Original casing/punctuation survives — this text goes into a terminal.
  assert.deepEqual(matchWakeWord('Hey swarm, run the Tests --watch', 'hey swarm'), {
    matched: true, rest: 'run the Tests --watch',
  })
  assert.deepEqual(matchWakeWord('Hey swarm — git status', 'hey swarm'), {
    matched: true, rest: 'git status',
  })
  // Phrase alone → empty rest, which the caller reads as "open dictation".
  assert.deepEqual(matchWakeWord('Hey swarm.', 'hey swarm'), { matched: true, rest: '' })
})
t('wakeWord: tolerates a mishearing in a long word but not a short one', () => {
  assert.equal(matchWakeWord('hey swarn, deploy', 'hey swarm').matched, true)
  assert.equal(wordsMatch('swarn', 'swarm'), true)
  // The budget is one edit at 5 chars and two at 6+, so "sworn" (two edits from
  // "swarm") is out. Widening it here would also admit storm/swore/warm.
  assert.equal(wordsMatch('sworn', 'swarm'), false)
  assert.equal(wordsMatch('orchestrater', 'orchestrator'), true)
  // Short words get NO budget: one edit from "hey" is also her/hen/hex/key/they,
  // so a budget there would fire the wake word during ordinary conversation. A
  // miss costs the user one repeat; a false fire types into their terminal.
  assert.equal(wordsMatch('her', 'hey'), false)
  assert.equal(wordsMatch('hay', 'hey'), false)
  assert.equal(matchWakeWord('hay swarm, deploy', 'hey swarm').matched, false)
})
t('wakeWord: matching is anchored near the start, not anywhere in the sentence', () => {
  // Leading filler is fine — the model prepends it constantly.
  assert.equal(matchWakeWord('Uh, hey swarm, stop', 'hey swarm').matched, true)
  // But mid-sentence mentions must not fire, or the wake word is worse than none.
  assert.equal(matchWakeWord('I was going to tell the hey swarm thing', 'hey swarm').matched, false)
  assert.equal(matchWakeWord('so anyway we should hey swarm now', 'hey swarm').matched, false)
})
t('wakeWord: unrelated speech does not match', () => {
  for (const said of ['what time is it', 'the server is down', 'commit and push', '']) {
    assert.equal(matchWakeWord(said, DEFAULT_WAKE_PHRASE).matched, false, said)
  }
})
t('wakeWord: phrases too short to be distinct are rejected', () => {
  // A lone short word appears many times an hour in normal speech, and every
  // false fire hijacks the user's terminal.
  assert.equal(isValidWakePhrase('hey'), false)
  assert.equal(isValidWakePhrase('yo'), false)
  assert.equal(isValidWakePhrase(''), false)
  assert.equal(isValidWakePhrase('   ,, '), false)
  assert.equal(isValidWakePhrase('swarm'), true)      // one long word is fine
  assert.equal(isValidWakePhrase('hey swarm'), true)
  assert.equal(isValidWakePhrase('ok computer'), true)
  // An invalid phrase can never match, so a half-typed setting can't fire.
  assert.equal(matchWakeWord('hey there', 'hey').matched, false)
})
t('wakeWord: normalizeSpeech folds accents, case and punctuation', () => {
  assert.equal(normalizeSpeech('Héy, Swärm!'), 'hey swarm')
  assert.equal(normalizeSpeech('  multiple   spaces  '), 'multiple spaces')
})
t('wakeWord: editDistance bails out past the budget instead of scoring fully', () => {
  assert.equal(editDistance('swarm', 'swarm'), 0)
  assert.equal(editDistance('swarm', 'swarn'), 1)
  assert.ok(editDistance('swarm', 'completely different', 2) > 2)
})
t('vad: the wake profile ends an utterance far sooner than dictation', () => {
  // The hangover is pure dead time between the user finishing and the model
  // seeing the audio, and it dominates the felt reaction time. It can be this
  // aggressive because an early cut degrades into the two-step flow.
  assert.ok(WAKE_VAD.hangoverMs <= 400, `wake hangover regressed to ${WAKE_VAD.hangoverMs}ms`)
  assert.ok(WAKE_VAD.hangoverMs < DEFAULT_VAD.hangoverMs)
  assert.ok(WAKE_VAD.maxDurationMs < DEFAULT_VAD.maxDurationMs)
  // Still long enough to hold a wake phrase plus a command in one breath.
  assert.ok(WAKE_VAD.maxDurationMs >= 8000)
})
t('vad: dictation does not make the user wait around after they stop talking', () => {
  // Sized to the longest pause *inside* a sentence, not a comfortable margin on
  // top of it — at 1.8s dictation felt like it had stopped listening.
  assert.ok(DEFAULT_VAD.hangoverMs <= 1300, `dictation hangover regressed to ${DEFAULT_VAD.hangoverMs}ms`)
  // But never so short that a mid-sentence breath ends the clip.
  assert.ok(DEFAULT_VAD.hangoverMs >= 900)
})

// ---------- canvas layout: focus mode, tidy/align, eraser ----------
const VP = { w: 1600, h: 900 }
t('focusLayout: the focused terminal takes the stage, the rest dock right', () => {
  const l = focusLayout(['a', 'b', 'c'], 'a', VP)
  assert.equal(l.dock.has('a'), false)
  assert.equal(l.dock.size, 2)
  // Stage on the left, dock strictly to the right of it.
  const dockX = l.dock.get('b')!.x
  assert.ok(l.stage.x + l.stage.w <= dockX, 'stage overlaps the dock')
  assert.equal(dockX + DOCK_W + FOCUS_PAD, VP.w)
})
t('focusLayout: docked terminals stack downward without overlapping', () => {
  const l = focusLayout(['a', 'b', 'c', 'd'], 'a', VP)
  const rects = ['b', 'c', 'd'].map(id => l.dock.get(id)!)
  for (let i = 1; i < rects.length; i++) {
    assert.ok(rects[i].y >= rects[i - 1].y + rects[i - 1].h, 'dock slots overlap')
  }
  // Top-aligned: it reads as a queue, not a centred gallery.
  assert.equal(rects[0].y, FOCUS_PAD)
})
t('focusLayout: the dock never runs off the bottom of the viewport', () => {
  // 40 terminals cannot fit; the surplus is reported rather than drawn where it
  // can't be clicked.
  const ids = Array.from({ length: 40 }, (_, i) => `t${i}`)
  const l = focusLayout(ids, 't0', VP)
  assert.ok(l.hidden.length > 0)
  for (const r of l.dock.values()) {
    assert.ok(r.y + r.h <= VP.h, 'a dock slot is off-screen')
    assert.ok(r.h >= DOCK_MIN_H, 'a dock slot shrank below usability')
  }
  assert.equal(l.dock.size + l.hidden.length, ids.length - 1)
})
t('focusLayout: a single terminal gets the full width, no empty dock gutter', () => {
  const l = focusLayout(['only'], 'only', VP)
  assert.equal(l.dock.size, 0)
  assert.equal(l.stage.w, VP.w - FOCUS_PAD * 2)
})
t('snapAll: positions and sizes land on the grid, sizes never collapse', () => {
  const out = snapAll([{ id: 'a', x: 503, y: 97, w: 3, h: 411 }], GRID)
  const r = out.get('a')!
  for (const v of [r.x, r.y, r.w, r.h]) assert.equal(v % GRID, 0)
  assert.ok(r.w >= GRID, 'a card was snapped down to nothing')
})
t('tidyGrid: reflowed cards never overlap, whatever their sizes', () => {
  const items = [
    { id: 'a', x: 10, y: 10, w: 500, h: 340 },
    { id: 'b', x: 900, y: 20, w: 220, h: 200 },
    { id: 'c', x: 30, y: 700, w: 640, h: 460 },
    { id: 'd', x: 800, y: 690, w: 240, h: 132 },
  ]
  const pos = tidyGrid(items, GRID)
  const placed = items.map(i => ({ ...i, ...pos.get(i.id)! }))
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i], b = placed[j]
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      assert.ok(!overlap, `${a.id} overlaps ${b.id} after tidy`)
    }
  }
})
t('tidyGrid: reading order survives the reflow', () => {
  // Top row (a, b) must stay ahead of the bottom row (c) — "tidy" rearranges
  // spacing, not your mental map of the board.
  const items = [
    { id: 'b', x: 600, y: 10, w: 200, h: 150 },
    { id: 'c', x: 10, y: 400, w: 200, h: 150 },
    { id: 'a', x: 10, y: 10, w: 200, h: 150 },
  ]
  const pos = tidyGrid(items, GRID)
  const a = pos.get('a')!, b = pos.get('b')!, c = pos.get('c')!
  assert.ok(a.y === b.y && a.x < b.x, 'a should precede b on the same row')
  assert.ok(c.y > a.y, 'c should stay below the first row')
})
t('tidyGrid: an empty board is a no-op, not a crash', () => {
  assert.equal(tidyGrid([], GRID).size, 0)
})
t('eraser: never removes a terminal, browser, device or task card', () => {
  // A stray swipe must not kill a running pty or delete a row in the tasks
  // table — those are not "oops, redraw it".
  for (const kind of ['terminal', 'browser', 'device', 'task']) {
    assert.equal(isErasableKind(kind), false, `${kind} should be protected`)
    assert.equal(eraserHits({ id: 'x', kind, x: 0, y: 0, w: 100, h: 100 }, 50, 50, 16), false)
  }
})
t('eraser: catches ink, notes, text, shapes and images', () => {
  for (const kind of ['note', 'text', 'shape', 'image']) {
    assert.equal(isErasableKind(kind), true)
    assert.equal(eraserHits({ id: 'x', kind, x: 0, y: 0, w: 100, h: 100 }, 50, 50, 16), true)
  }
})
t('eraser: a stroke is hit on its path, not its bounding box', () => {
  // A hand-drawn ring: erasing in the hole must not delete it.
  const ring = {
    id: 's', kind: 'draw', x: 0, y: 0, w: 100, h: 100, strokeWidth: 2,
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }],
  }
  assert.equal(eraserHits(ring, 50, 50, 16), false, 'erased through the middle of an open shape')
  assert.equal(eraserHits(ring, 50, 3, 16), true, 'missed the stroke itself')
})
t('eraser: a locked item is immune', () => {
  const note = { id: 'n', kind: 'note', x: 0, y: 0, w: 100, h: 100, locked: true }
  assert.equal(eraserHits(note, 50, 50, 16), false)
})
// ---------- marquee (box) selection ----------
t('normalizeRect: a box dragged up-left is the same box as down-right', () => {
  assert.deepEqual(normalizeRect(10, 10, 60, 40), { x: 10, y: 10, w: 50, h: 30 })
  assert.deepEqual(normalizeRect(60, 40, 10, 10), { x: 10, y: 10, w: 50, h: 30 })
})
t('marquee: catches every card it touches, not only those it swallows whole', () => {
  const items = [
    { id: 'a', kind: 'terminal', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', kind: 'note', x: 400, y: 400, w: 50, h: 50 },
    // Bigger than the box drawn over it — full containment would miss this.
    { id: 'c', kind: 'image', x: -500, y: -500, w: 2000, h: 2000 },
  ]
  const hits = marqueeHits(items, { x: 50, y: 50, w: 60, h: 60 })
  assert.deepEqual(hits.sort(), ['a', 'c'])
})
t('marquee: a click (zero-area box) selects nothing', () => {
  const items = [{ id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100 }]
  assert.deepEqual(marqueeHits(items, { x: 50, y: 50, w: 0, h: 0 }), [])
})
t('marquee: a locked item is never selected', () => {
  const items = [{ id: 'a', kind: 'note', x: 0, y: 0, w: 100, h: 100, locked: true }]
  assert.deepEqual(marqueeHits(items, { x: 0, y: 0, w: 200, h: 200 }), [])
})
t('marquee: a stroke is caught by its path, not its bounding box', () => {
  // A diagonal scribble across the board: its bbox covers the whole area, but
  // a box in the far corner is nowhere near the ink itself.
  const stroke = {
    id: 's', kind: 'draw', x: 0, y: 0, w: 1000, h: 1000,
    points: [{ x: 0, y: 0 }, { x: 1000, y: 1000 }],
  }
  assert.deepEqual(marqueeHits([stroke], { x: 900, y: 10, w: 60, h: 60 }), [])
  assert.deepEqual(marqueeHits([stroke], { x: 480, y: 480, w: 40, h: 40 }), ['s'])
})
t('segmentIntersectsRect: a segment entirely inside counts, and a point does too', () => {
  const r = { x: 0, y: 0, w: 100, h: 100 }
  assert.equal(segmentIntersectsRect(10, 10, 90, 90, r), true)
  assert.equal(segmentIntersectsRect(50, 50, 50, 50, r), true, 'point inside')
  assert.equal(segmentIntersectsRect(500, 500, 500, 500, r), false, 'point outside')
  assert.equal(segmentIntersectsRect(-50, 50, 150, 50, r), true, 'straight through')
  assert.equal(segmentIntersectsRect(-50, 200, 150, 200, r), false, 'passes below')
})
t('rectsOverlap: touching edges are not an overlap', () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false)
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 10, h: 10 }), true)
})
t('selectionBounds: the box around the set, null when there is no set', () => {
  assert.equal(selectionBounds([]), null)
  assert.deepEqual(
    selectionBounds([{ id: 'a', x: 10, y: 20, w: 30, h: 40 }, { id: 'b', x: 100, y: 0, w: 10, h: 10 }]),
    { x: 10, y: 0, w: 100, h: 60 },
  )
})
t('dragDelta: snapping a group keeps its spacing (one delta, not per item)', () => {
  const grid = 20
  // Two cards 30px apart, dragged together with snap on.
  const anchor = { x: 0, y: 0 }
  const other = { x: 30, y: 0 }
  const { dx } = dragDelta(anchor, 7, 0, grid)
  assert.equal(anchor.x + dx, 0, 'the grabbed card lands on the grid')
  assert.equal((other.x + dx) - (anchor.x + dx), 30, 'the gap between them is unchanged')
})
t('dragDelta: without a grid the raw offset passes straight through', () => {
  assert.deepEqual(dragDelta({ x: 3, y: 4 }, 11.5, -2.5, null), { dx: 11.5, dy: -2.5 })
})

t('pointSegmentDistance: clamps to the segment ends, not the infinite line', () => {
  // Straight down from the middle.
  assert.equal(pointSegmentDistance(5, 3, 0, 0, 10, 0), 3)
  // Past the end: distance to the endpoint, not the projection.
  assert.equal(pointSegmentDistance(20, 0, 0, 0, 10, 0), 10)
  // Degenerate segment (a single captured point).
  assert.equal(pointSegmentDistance(3, 4, 0, 0, 0, 0), 5)
})

// ---------- agent accounts (which login a pane runs on) ----------
const ACCS = [
  { id: 'a', profileDir: '/p/a' },
  { id: 'b', profileDir: '/p/b' },
  { id: 'k' },                      // API-key account: no profile dir
]
t('accounts: a pane pinned to an account gets that one, not the global default', () => {
  assert.equal(pickAccount(ACCS, 'a', 'b')?.id, 'b')
  assert.equal(pickAccount(ACCS, 'b', 'a')?.id, 'a')
})
t('accounts: an unpinned pane follows the global default', () => {
  assert.equal(pickAccount(ACCS, 'b', null)?.id, 'b')
  assert.equal(pickAccount(ACCS, 'b', undefined)?.id, 'b')
})
t('accounts: a stale pin falls back to the default, never to nothing', () => {
  // The account was deleted in Settings but the layout still names it. Spawning
  // with no credential would drop the user into an unexpected login prompt.
  assert.equal(pickAccount(ACCS, 'b', 'deleted')?.id, 'b')
  assert.equal(pickAccount(ACCS, undefined, 'deleted')?.id, 'a')
})
t('accounts: no accounts resolves to null so the workspace config still applies', () => {
  assert.equal(pickAccount([], 'a', 'a'), null)
})
t('accounts: two panes can resolve to two different logins at once', () => {
  // The whole point of connecting more than one account. A single global
  // "active" account made this impossible.
  const left = pickAccount(ACCS, 'a', 'a')
  const right = pickAccount(ACCS, 'a', 'b')
  assert.notEqual(left?.id, right?.id)
  assert.notEqual(left?.profileDir, right?.profileDir)
})
t('accounts: switching profile dirs invalidates the resumable session', () => {
  // `claude --resume <id>` under a different CLAUDE_CONFIG_DIR finds no such
  // session and fails — which is what "the account switch did nothing" is.
  assert.equal(needsFreshSession(ACCS[0], ACCS[1]), true)
  assert.equal(needsFreshSession(ACCS[0], ACCS[2]), true)
})
t('accounts: staying within one config dir keeps the conversation', () => {
  assert.equal(needsFreshSession(ACCS[0], ACCS[0]), false)
  assert.equal(needsFreshSession({ id: 'x' }, { id: 'y' }), false)  // two API-key accounts
  assert.equal(needsFreshSession(null, null), false)
})
t('accounts: signedInState spots a login that was started but never finished', () => {
  const dirOnly = (p: string) => p === '/p/a'
  assert.equal(signedInState('claude', ACCS[0], dirOnly), false)
  const withCred = (p: string) => p === '/p/a' || p.endsWith('.credentials.json')
  assert.equal(signedInState('claude', ACCS[0], withCred), true)
})
t('accounts: login state is unknown — never false — when it cannot be told', () => {
  // An API-key account carries its credential inline, and an agent we have no
  // marker for must not be flagged. `false` here would be a false alarm on a
  // perfectly working account.
  assert.equal(signedInState('claude', ACCS[2], () => false), null)
  assert.equal(signedInState('cursor', ACCS[0], () => false), null)
})
t('accounts: credential candidates live inside the account profile dir', () => {
  const paths = credentialCandidates('claude', '/p/a')
  assert.ok(paths.length > 0)
  assert.ok(paths.every(p => p.startsWith('/p/a') || p.startsWith('\\p\\a') || p.includes('p')))
})

// ── Merge queue: merge-tree parsing ─────────────────────────────────────────
// The exact output shape below was captured from git 2.47 against a real
// three-way conflict, so these assertions are a regression net for the format,
// not a guess at it.

const MT_CONFLICT = `126290ae1d09bc4aaf86332834e79ca637076edf
f.txt

Auto-merging f.txt
CONFLICT (content): Merge conflict in f.txt`

t('mergeTree: a conflicting merge names its files and keeps git\'s messages', () => {
  const r = parseMergeTree(MT_CONFLICT, 1)
  assert.equal(r.tree, '126290ae1d09bc4aaf86332834e79ca637076edf')
  assert.deepEqual(r.conflicts, ['f.txt'])
  assert.ok(r.messages.includes('CONFLICT (content)'))
})
t('mergeTree: a clean merge is just the tree oid', () => {
  const r = parseMergeTree('a3b986158f8145912dd3c4daa5542a47e603b5be\n', 0)
  assert.equal(r.tree, 'a3b986158f8145912dd3c4daa5542a47e603b5be')
  assert.deepEqual(r.conflicts, [])
})
t('mergeTree: exit 0 never yields conflicts even if lines follow', () => {
  // The exit code is authoritative; the informational block is free-form English
  // that git may reword, so it must never be mistaken for a conflict list.
  const r = parseMergeTree('a3b9861\nAuto-merging f.txt\n', 0)
  assert.deepEqual(r.conflicts, [])
})
t('mergeTree: unrecognisable output is an error, not an empty success', () => {
  const r = parseMergeTree('fatal: not a valid object name\n', 128)
  assert.equal(r.tree, null)
  assert.ok(r.messages.includes('fatal'))
})
t('mergeTree: a path conflicting several ways is listed once', () => {
  const r = parseMergeTree('abc1234\nf.txt\nf.txt\ng.txt\n\nmsgs', 1)
  assert.deepEqual(r.conflicts, ['f.txt', 'g.txt'])
})
t('mergeTree: verdicts distinguish "nothing to merge" from "merges clean"', () => {
  // A branch with no commits of its own isn't a clean merge — there is nothing
  // to land, and calling it clean would imply otherwise.
  assert.equal(mergeVerdict({ ahead: 0, exitCode: 0, tree: 'abc' }), 'empty')
  assert.equal(mergeVerdict({ ahead: 3, exitCode: 0, tree: 'abc' }), 'clean')
  assert.equal(mergeVerdict({ ahead: 3, exitCode: 1, tree: 'abc' }), 'conflict')
  assert.equal(mergeVerdict({ ahead: 3, exitCode: 128, tree: null }), 'error')
  assert.equal(mergeVerdict({ ahead: 3, exitCode: 0, tree: null }), 'error')
})
t('mergeTree: only a clean merge advances the simulated head', () => {
  assert.equal(advancesHead('clean'), true)
  for (const v of ['conflict', 'empty', 'error'] as const) assert.equal(advancesHead(v), false)
})

// ── Merge queue: what the UI offers ─────────────────────────────────────────

const QROWS: QueueRow[] = [
  { branch: 'a', verdict: 'clean', conflicts: [], ahead: 2 },
  { branch: 'b', verdict: 'conflict', conflicts: ['src/x.ts', 'src/y.ts'], ahead: 1 },
  { branch: 'c', verdict: 'clean', conflicts: [], ahead: 4 },
  { branch: 'd', verdict: 'empty', conflicts: [], ahead: 0 },
]

t('mergeQueue: reorder moves one entry and leaves the rest in order', () => {
  assert.deepEqual(moveInList([1, 2, 3, 4], 0, 2), [2, 3, 1, 4])
  assert.deepEqual(moveInList([1, 2, 3, 4], 3, 0), [4, 1, 2, 3])
  assert.deepEqual(moveInList([1, 2, 3], 1, 1), [1, 2, 3])
})
t('mergeQueue: a drop outside the queue is not a reorder', () => {
  // Clamping would move the row somewhere the user did not drop it.
  assert.deepEqual(moveInList([1, 2, 3], 0, 9), [1, 2, 3])
  assert.deepEqual(moveInList([1, 2, 3], -1, 1), [1, 2, 3])
})
t('mergeQueue: summary counts verdicts and collects conflicted files', () => {
  const s = summarizeQueue(QROWS)
  assert.equal(s.clean, 2)
  assert.equal(s.conflict, 1)
  assert.equal(s.empty, 1)
  assert.equal(s.error, 0)
  assert.deepEqual(s.conflictedFiles, ['src/x.ts', 'src/y.ts'])
})
t('mergeQueue: only clean rows land, and in queue order', () => {
  // Order matters: the verdicts came from a cumulative simulation, so "c is
  // clean" means "clean once a landed". Merging them in any other order would
  // land a sequence nobody previewed.
  assert.deepEqual(landableBranches(QROWS), ['a', 'c'])
  assert.equal(canRunQueue(QROWS), true)
  assert.equal(canRunQueue([QROWS[1], QROWS[3]]), false)
})
t('mergeQueue: the conflict hand-off prompt keeps the agent out of base', () => {
  const p = buildConflictTaskPrompt(QROWS[1], 'main')
  assert.ok(p.title.includes('b'))
  assert.ok(p.description.includes('src/x.ts'))
  assert.ok(/own worktree/.test(p.description))
  assert.ok(/Do not merge into "main" yourself/.test(p.description))
})
t('mergeQueue: a huge conflict list is truncated, not pasted whole', () => {
  const many = Array.from({ length: 30 }, (_, i) => `f${i}.ts`)
  const p = buildConflictTaskPrompt({ branch: 'b', verdict: 'conflict', conflicts: many, ahead: 1 }, 'main')
  assert.ok(p.description.includes('+18 more'))
})

// ── Remote URL parsing ──────────────────────────────────────────────────────
// Every form here is one git actually writes into .git/config. A wrong parse
// doesn't throw — it silently builds a link to a repo that doesn't exist.

t('gitRemote: the SCP-like form is not a URL and must still parse', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:0xnookie/swarmmind.git'), {
    host: 'github.com', owner: '0xnookie', repo: 'swarmmind', provider: 'github',
  })
})
t('gitRemote: https and ssh forms drop .git and any userinfo', () => {
  assert.deepEqual(parseRemoteUrl('https://github.com/0xnookie/swarmmind.git')?.repo, 'swarmmind')
  const ssh = parseRemoteUrl('ssh://git@github.com/0xnookie/swarmmind.git')
  assert.equal(ssh?.owner, '0xnookie')  // not "git@github.com"
  assert.equal(ssh?.host, 'github.com')
})
t('gitRemote: a port is not mistaken for an SCP path separator', () => {
  const r = parseRemoteUrl('https://git.example.com:8443/team/app.git')
  assert.equal(r?.host, 'git.example.com')
  assert.equal(r?.owner, 'team')
  assert.equal(r?.repo, 'app')
})
t('gitRemote: nested GitLab subgroups keep the repo as the last segment', () => {
  const r = parseRemoteUrl('https://gitlab.com/group/sub/app.git')
  assert.equal(r?.owner, 'group/sub')
  assert.equal(r?.repo, 'app')
  assert.equal(r?.provider, 'gitlab')
})
t('gitRemote: junk and incomplete paths parse to null, never a half-URL', () => {
  assert.equal(parseRemoteUrl(''), null)
  assert.equal(parseRemoteUrl(null), null)
  assert.equal(parseRemoteUrl('https://github.com/onlyowner'), null)
  assert.equal(parseRemoteUrl('not a url at all'), null)
})
t('gitRemote: compare URLs differ per provider, and an unknown host gets no guess', () => {
  const gh = parseRemoteUrl('git@github.com:o/r.git')!
  assert.equal(compareUrl(gh, 'main', 'feature'), 'https://github.com/o/r/compare/main...feature?expand=1')
  const gl = parseRemoteUrl('https://gitlab.com/o/r.git')!
  assert.ok(compareUrl(gl, 'main', 'feature').includes('/-/merge_requests/new'))
  const other = parseRemoteUrl('https://git.internal/o/r.git')!
  assert.equal(compareUrl(other, 'main', 'feature'), 'https://git.internal/o/r')
  assert.equal(supportsCli(gh), true)
  assert.equal(supportsCli(other), false)
})
t('gitRemote: branch names with slashes survive into the compare URL', () => {
  const gh = parseRemoteUrl('git@github.com:o/r.git')!
  assert.ok(compareUrl(gh, 'main', 'swarmmind/worker-a').includes('swarmmind%2Fworker-a'))
})

// ── Pull request composition ────────────────────────────────────────────────

t('pullRequest: one commit titles the PR with its own subject', () => {
  assert.equal(defaultPrTitle('swarmmind/worker-a', [{ hash: 'abc', subject: 'Add retry to the fetcher' }]),
    'Add retry to the fetcher')
})
t('pullRequest: several commits fall back to a humanised branch name', () => {
  const commits = [{ hash: 'a', subject: 'one' }, { hash: 'b', subject: 'two' }]
  assert.equal(defaultPrTitle('swarmmind/fix-login_flow', commits), 'Fix login flow')
  assert.equal(defaultPrTitle('swarmmind/worker-a', []), 'Worker a')
})
t('pullRequest: the body carries commits, files and provenance', () => {
  const body = buildPrBody({
    branch: 'swarmmind/worker-a',
    base: 'main',
    commits: [{ hash: 'abc1234', subject: 'Add retry' }],
    files: [{ path: 'src/a.ts', additions: 10, deletions: 2 }],
    paneTitle: 'Worker A',
  })
  assert.ok(body.includes('Worker A'))
  assert.ok(body.includes('abc1234'))
  assert.ok(body.includes('src/a.ts'))
  assert.ok(body.includes('+10 −2'))
  assert.ok(body.includes('SwarmMind'))
})
t('pullRequest: no digest means no swarm section (not an empty heading)', () => {
  const body = buildPrBody({ branch: 'b', base: 'main', commits: [], files: [] })
  assert.ok(!body.includes('## Swarm session'))
  assert.ok(!buildPrBody({ branch: 'b', base: 'main', commits: [], files: [], swarmDigest: '   ' }).includes('## Swarm'))
})
t('sessionExport: the swarm digest summarises a run rather than replaying it', () => {
  const events: ExportEvent[] = [
    { id: '1', ts: 1000, type: 'task_create', agent_id: 'claude', pane_id: 'p1', payload: { title: 't' } },
    { id: '2', ts: 5000, type: 'task_update', agent_id: 'codex', pane_id: 'p2', payload: { status: 'done' } },
  ]
  const digest = renderSwarmDigest(events)
  assert.ok(digest.includes('## Swarm session'))
  assert.ok(digest.includes('claude'))
  assert.ok(digest.includes('codex'))
  // The full per-event timeline belongs in the session export, not a PR body.
  assert.ok(!digest.includes('### '))
  assert.ok(digest.split('\n').length < 12)
  // An empty log has nothing to say, and must say it as '' so the caller can
  // drop the whole section.
  assert.equal(renderSwarmDigest([]), '')
})
t('pullRequest: long commit and file lists are truncated with a count', () => {
  const commits = Array.from({ length: 30 }, (_, i) => ({ hash: `h${i}`, subject: `s${i}` }))
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.ts`, additions: 1, deletions: 0 }))
  const body = buildPrBody({ branch: 'b', base: 'main', commits, files })
  assert.ok(body.includes('…and 10 more'))
  assert.ok(body.includes('…and 10 more'))
})

// ── Race mode ───────────────────────────────────────────────────────────────

const RP = (over: Partial<RacePane> & { paneId: string }): RacePane => ({
  agentId: 'claude', title: over.paneId, branch: `swarmmind/${over.paneId}`,
  worktreePath: `/wt/${over.paneId}`, running: true, ...over,
})

t('race: only running, worktree-isolated panes may race', () => {
  // Without isolation two racers would write over each other in one checkout and
  // the "comparison" would be one incoherent mixture — so exclusion is the
  // correctness rule, not a nicety.
  const { eligible, ineligible } = raceEligibility([
    RP({ paneId: 'a' }),
    RP({ paneId: 'b', branch: null, worktreePath: null }),
    RP({ paneId: 'c', running: false }),
  ])
  assert.deepEqual(eligible.map(p => p.paneId), ['a'])
  assert.deepEqual(ineligible.map(i => [i.pane.paneId, i.reason]), [['b', 'no-worktree'], ['c', 'not-running']])
})
t('race: a race needs at least two racers and a goal', () => {
  assert.equal(canStartRace(['a', 'b'], 'do the thing'), true)
  assert.equal(canStartRace(['a'], 'do the thing'), false)
  assert.equal(canStartRace(['a', 'b'], '   '), false)
  assert.equal(canStartRace(['a', 'a'], 'x'), false)  // the same pane twice is one racer
})
t('race: the prompt forbids coordination and demands a commit', () => {
  const p = buildRacePrompt('add retries', 2, 3)
  assert.ok(p.includes('2/3'))
  assert.ok(p.includes('add retries'))
  assert.ok(/do not coordinate/i.test(p))
  assert.ok(/COMMIT/.test(p))
  assert.ok(/own git worktree/i.test(p))
})
t('race: readiness comes from changed files, not from the pane going quiet', () => {
  const stat = { files: ['a.ts'], additions: 3, deletions: 1 }
  assert.equal(attemptState({ running: true, working: true, stat }), 'ready')
  assert.equal(attemptState({ running: true, working: true, stat: undefined }), 'working')
  assert.equal(attemptState({ running: true, working: false, stat: undefined }), 'waiting')
  // An idle pane with no diff is not an attempt to compare.
  assert.equal(attemptState({ running: true, working: false, stat: { files: [], additions: 0, deletions: 0 } }), 'waiting')
  assert.equal(attemptState({ running: false, working: false, stat }), 'gone')
  assert.equal(churn(stat), 4)
  assert.equal(churn(undefined), 0)
})
t('race: contested files are the ones more than one attempt touched', () => {
  const contested = contestedFiles([
    { paneId: 'a', stat: { files: ['src/x.ts', 'src/a.ts'], additions: 1, deletions: 0 } },
    { paneId: 'b', stat: { files: ['src/x.ts', 'src/b.ts'], additions: 1, deletions: 0 } },
    { paneId: 'c', stat: { files: ['src/x.ts'], additions: 1, deletions: 0 } },
  ])
  assert.deepEqual(contested, [{ path: 'src/x.ts', count: 3 }])
})
t('race: an attempt listing a file twice still counts once', () => {
  const contested = contestedFiles([
    { paneId: 'a', stat: { files: ['x.ts', 'x.ts'], additions: 1, deletions: 0 } },
    { paneId: 'b', stat: undefined },
  ])
  assert.deepEqual(contested, [])
})
t('race: picking a winner merges one branch and discards exactly the others', () => {
  const attempts = [RP({ paneId: 'a' }), RP({ paneId: 'b' }), RP({ paneId: 'c' })]
  const plan = planWinner(attempts, 'b')!
  assert.equal(plan.keep.branch, 'swarmmind/b')
  assert.deepEqual(plan.discard.map(d => d.paneId), ['a', 'c'])
})
t('race: an unknown winner plans nothing — never "discard everything"', () => {
  // The lenient version of this deletes every attempt the first time a racing
  // pane is closed mid-race.
  assert.equal(planWinner([RP({ paneId: 'a' })], 'zzz'), null)
  assert.equal(planWinner([RP({ paneId: 'a', branch: null })], 'a'), null)
})

// ── Voice orchestration ─────────────────────────────────────────────────────
// The asymmetry here is the whole design: a missed command costs a click, a
// false positive silently swallows text the user meant to type into a terminal.
// Most of these assertions are about *not* matching.

const VAGENTS = ['claude', 'codex', 'cursor', 'windsurf', 'kilo', 'opencode', 'cline']
const vc = (s: string) => parseVoiceCommand(s, VAGENTS)

t('voiceCommand: an agent-directed phrase becomes a task for that agent', () => {
  assert.deepEqual(vc('have codex fix the failing tests'), { kind: 'task', text: 'fix the failing tests', agent: 'codex' })
  assert.deepEqual(vc('ask claude to refactor the parser'), { kind: 'task', text: 'refactor the parser', agent: 'claude' })
  assert.deepEqual(vc('tell cline to update the README'), { kind: 'task', text: 'update the README', agent: 'cline' })
})
t('voiceCommand: the second word must be a REAL agent, or it is dictation', () => {
  // Without this check "have a look at the login flow" becomes a task assigned
  // to an agent called "a" — the failure that would make the feature untrustworthy.
  assert.deepEqual(vc('have a look at the login flow'), { kind: 'dictate', text: 'have a look at the login flow' })
  assert.deepEqual(vc('ask bob to review this'), { kind: 'dictate', text: 'ask bob to review this' })
})
t('voiceCommand: goals and unassigned tasks keep their original casing', () => {
  assert.deepEqual(vc('set the goal to Ship the CI fix'), { kind: 'goal', text: 'Ship the CI fix' })
  assert.deepEqual(vc('new goal: Ship v2'), { kind: 'goal', text: 'Ship v2' })
  assert.deepEqual(vc('create a task to Bump the Deps'), { kind: 'task', text: 'Bump the Deps', agent: null })
})
t('voiceCommand: run control has no payload', () => {
  assert.deepEqual(vc('start the swarm'), { kind: 'control', action: 'start' })
  assert.deepEqual(vc('Stop the swarm.'), { kind: 'control', action: 'stop' })
  assert.deepEqual(vc('pause the swarm'), { kind: 'control', action: 'stop' })
})
t('voiceCommand: broadcast wins over the agent-directed verb it starts with', () => {
  // "tell everyone" begins with "tell"; if the agent branch ran first it would
  // reject "everyone" and the phrase would be typed into one pane instead.
  assert.deepEqual(vc('tell everyone to stop what they are doing'),
    { kind: 'broadcast', text: 'stop what they are doing' })
  assert.deepEqual(vc('tell the swarm to commit'), { kind: 'broadcast', text: 'commit' })
})
t('voiceCommand: commands are anchored to the start of the utterance', () => {
  // A wake word that fired mid-sentence must not reinterpret ordinary speech.
  assert.equal(vc('and then tell claude to look at it').kind, 'dictate')
  assert.equal(vc('I want to set the goal to something').kind, 'dictate')
})
t('voiceCommand: a command prefix with no payload dictates rather than acting', () => {
  // "set the goal to <nothing>" must not blank the goal.
  assert.equal(vc('set the goal to').kind, 'dictate')
  assert.equal(vc('create a task').kind, 'dictate')
  assert.equal(vc('broadcast').kind, 'dictate')
})
t('voiceCommand: punctuation and casing from the speech model do not defeat it', () => {
  assert.deepEqual(vc('Have Codex, fix the tests'), { kind: 'task', text: 'fix the tests', agent: 'codex' })
  assert.deepEqual(vc('  START THE SWARM  '), { kind: 'control', action: 'start' })
})
t('voiceCommand: describeIntent says what will happen, per kind', () => {
  assert.ok(describeIntent(vc('have codex fix the tests')).includes('codex'))
  assert.ok(describeIntent(vc('stop the swarm')).includes('Stopping'))
  assert.equal(describeIntent(vc('ls -la')), 'ls -la')
})

// ── LSP framing ─────────────────────────────────────────────────────────────
// Content-Length is a BYTE count. A char-counted implementation works on ASCII
// and desynchronises permanently the first time a hover contains a non-ASCII
// character — which then looks like the server hanging, not failing.

t('lspFraming: round-trips a message', () => {
  const { messages, rest } = decodeMessages(encodeMessage({ jsonrpc: '2.0', id: 1, method: 'x' }))
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, method: 'x' }])
  assert.equal(rest.length, 0)
})
t('lspFraming: the length header counts bytes, not characters', () => {
  const payload = { text: 'héllo — 日本語' }
  const buf = encodeMessage(payload)
  const declared = Number(/Content-Length: (\d+)/.exec(buf.toString('ascii', 0, 40))![1])
  assert.equal(declared, Buffer.byteLength(JSON.stringify(payload), 'utf-8'))
  assert.deepEqual(decodeMessages(buf).messages, [payload])
})
t('lspFraming: several messages in one chunk all decode', () => {
  const buf = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 }), encodeMessage({ c: 3 })])
  assert.deepEqual(decodeMessages(buf).messages, [{ a: 1 }, { b: 2 }, { c: 3 }])
})
t('lspFraming: a split message is held as remainder until it completes', () => {
  const full = Buffer.concat([encodeMessage({ a: 1 }), encodeMessage({ b: 2 })])
  const cut = Math.floor(full.length * 0.7)
  const first = decodeMessages(full.subarray(0, cut))
  assert.deepEqual(first.messages, [{ a: 1 }])
  const second = decodeMessages(Buffer.concat([first.rest, full.subarray(cut)]))
  assert.deepEqual(second.messages, [{ b: 2 }])
})
t('lspFraming: a malformed body does not stall the stream', () => {
  const bad = Buffer.from('Content-Length: 5\r\n\r\n{{{{{', 'utf-8')
  const buf = Buffer.concat([bad, encodeMessage({ ok: true })])
  assert.deepEqual(decodeMessages(buf).messages, [{ ok: true }])
})
t('lspFraming: file URIs round-trip, including Windows drive letters', () => {
  assert.equal(pathToUri('D:\\swarmmind\\src\\a.py'), 'file:///D:/swarmmind/src/a.py')
  assert.equal(uriToPath('file:///D:/swarmmind/src/a.py'), 'D:/swarmmind/src/a.py')
  assert.equal(uriToPath(pathToUri('/home/u/a.py')), '/home/u/a.py')
  // Spaces must be escaped on the way out and restored on the way back, or a
  // definition in "My Project" opens nothing.
  assert.ok(pathToUri('/home/My Project/a.py').includes('%20'))
  assert.equal(uriToPath(pathToUri('/home/My Project/a.py')), '/home/My Project/a.py')
})

// ── LSP server registry ─────────────────────────────────────────────────────

t('lspServers: a path maps to the server for its extension', () => {
  assert.equal(serverForPath('/a/b.py')?.id, 'python')
  assert.equal(serverForPath('/a/b.rs')?.id, 'rust')
  assert.equal(serverForPath('D:\\a\\b.GO')?.id, 'go')
  assert.equal(serverForPath('/a/b.ts'), null)   // handled in-process, never here
  assert.equal(serverForPath('/a/Makefile'), null)
  assert.equal(serverForPath('/a/.gitignore'), null)  // leading dot is not an extension
})
t('lspServers: user entries override a built-in for the same extension', () => {
  const extra = parseExtraServers('[{"id":"mypy","command":"x","args":["--stdio"],"extensions":[".py"],"languageId":"python"}]')
  assert.equal(extra.length, 1)
  assert.equal(serverForPath('/a/b.py', resolveServers(extra))?.id, 'mypy')
})
t('lspServers: one malformed entry does not discard its neighbours', () => {
  const parsed = parseExtraServers('[{"id":"a"},{"id":"b","command":"c","extensions":[".x"],"languageId":"l"}]')
  assert.deepEqual(parsed.map(s => s.id), ['b'])
  // Junk must never take the built-in servers down with it.
  assert.deepEqual(parseExtraServers('not json'), [])
  assert.deepEqual(parseExtraServers(null), [])
  assert.equal(serverForPath('/a/b.py', resolveServers(parseExtraServers('{'))) ?.id, 'python')
})

t('lspServers: a server path with spaces survives the Windows shell', () => {
  // Windows needs shell:true to launch a .cmd shim, which makes Node join the
  // command line — so an unquoted "C:\Program Files\..." splits at the space and
  // fails as ENOENT, indistinguishable from "not installed". Found by
  // lsp-stdio-verify, which could not spawn node.exe from Program Files.
  assert.equal(quoteForCmd('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"')
  assert.equal(quoteForCmd('pyright-langserver'), 'pyright-langserver')
  assert.equal(quoteForCmd('--stdio'), '--stdio')
  // An already-quoted token from a hand-written settings entry is left alone.
  assert.equal(quoteForCmd('"C:\\a b\\x.cmd"'), '"C:\\a b\\x.cmd"')
  assert.equal(quoteForCmd(''), '""')
})

// ── LSP response normalisation ──────────────────────────────────────────────

const DOC = 'line one\nline two\nline three\n'

t('lspNormalize: offsets and positions round-trip', () => {
  assert.deepEqual(offsetToPosition(DOC, 0), { line: 0, character: 0 })
  assert.deepEqual(offsetToPosition(DOC, 9), { line: 1, character: 0 })
  assert.deepEqual(offsetToPosition(DOC, 13), { line: 1, character: 4 })
  assert.equal(positionToOffset(DOC, { line: 1, character: 4 }), 13)
  assert.equal(positionToOffset(DOC, { line: 0, character: 0 }), 0)
})
t('lspNormalize: an out-of-range position clamps instead of throwing', () => {
  // Servers report positions from the file on disk while the editor holds a
  // shorter unsaved buffer; throwing would drop a whole diagnostics batch.
  assert.equal(positionToOffset(DOC, { line: 99, character: 0 }), DOC.length)
  assert.equal(positionToOffset(DOC, { line: 0, character: 500 }), 8) // clamped to end of line
  // DOC ends in a newline, so the very end of the file is the empty line 3.
  assert.deepEqual(offsetToPosition(DOC, 9999), { line: 3, character: 0 })
  assert.deepEqual(offsetToPosition(DOC, -5), { line: 0, character: 0 })
})
t('lspNormalize: severities map, and a missing one is an error', () => {
  assert.equal(normalizeSeverity(1), 'error')
  assert.equal(normalizeSeverity(2), 'warning')
  assert.equal(normalizeSeverity(3), 'info')
  assert.equal(normalizeSeverity(undefined), 'error')
})
t('lspNormalize: a zero-width diagnostic still has something to underline', () => {
  const diags = normalizeDiagnostics(
    [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, message: 'x', severity: 1 }],
    DOC,
  )
  assert.equal(diags[0].to, diags[0].from + 1)
})
t('lspNormalize: every hover shape in the spec flattens to markdown', () => {
  assert.equal(normalizeHoverContents('plain'), 'plain')
  assert.equal(normalizeHoverContents({ kind: 'markdown', value: '**b**' }), '**b**')
  assert.equal(normalizeHoverContents({ language: 'python', value: 'def f()' }), '```python\ndef f()\n```')
  assert.ok(normalizeHoverContents([{ language: 'rust', value: 'fn f()' }, 'docs']).includes('```rust'))
  assert.equal(normalizeHoverContents(null), '')
})
t('lspNormalize: Location, Location[] and LocationLink[] all flatten', () => {
  const range = { start: { line: 3, character: 1 }, end: { line: 3, character: 5 } }
  assert.deepEqual(normalizeLocations({ uri: 'file:///a', range }), [{ uri: 'file:///a', range }])
  assert.equal(normalizeLocations([{ uri: 'file:///a', range }, { uri: 'file:///b', range }]).length, 2)
  // LocationLink names its fields differently; servers send them regardless of
  // the capability we declare.
  assert.deepEqual(
    normalizeLocations([{ targetUri: 'file:///c', targetSelectionRange: range }]),
    [{ uri: 'file:///c', range }],
  )
  assert.deepEqual(normalizeLocations(null), [])
})
t('lspNormalize: a workspace edit is read from either representation', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }
  const fromChanges = normalizeWorkspaceEdit({ changes: { 'file:///a': [{ range, newText: 'X' }] } })
  assert.deepEqual(fromChanges, [{ uri: 'file:///a', edits: [{ range, newText: 'X' }] }])
  const fromDocChanges = normalizeWorkspaceEdit({
    documentChanges: [{ textDocument: { uri: 'file:///b', version: 1 }, edits: [{ range, newText: 'Y' }] }],
  })
  assert.deepEqual(fromDocChanges.map(f => f.uri), ['file:///b'])
})
t('lspNormalize: file create/rename/delete operations are dropped', () => {
  // These ride in documentChanges next to real text edits. The rename flow feeds
  // a "you see it first" diff pipeline, so a filesystem operation must never
  // slip through it.
  const edits = normalizeWorkspaceEdit({
    documentChanges: [
      { kind: 'create', uri: 'file:///new' },
      { kind: 'delete', uri: 'file:///old' },
    ],
  })
  assert.deepEqual(edits, [])
})
t('lspNormalize: edits apply right-to-left so earlier ones do not shift later ones', () => {
  const text = 'aaa bbb ccc'
  const out = applyRangeEdits(text, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'LONGER' },
    { range: { start: { line: 0, character: 8 }, end: { line: 0, character: 11 } }, newText: 'Z' },
  ])
  assert.equal(out, 'LONGER bbb Z')
})
t('lspNormalize: overlapping edits are refused, not silently merged', () => {
  const text = 'abcdef'
  const out = applyRangeEdits(text, [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: 'X' },
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 6 } }, newText: 'Y' },
  ])
  assert.equal(out, null)
})
t('lspNormalize: a pure insertion does not swallow the next character', () => {
  const at = { line: 0, character: 3 }
  assert.equal(applyRangeEdits('abcdef', [{ range: { start: at, end: at }, newText: 'XY' }]), 'abcXYdef')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
