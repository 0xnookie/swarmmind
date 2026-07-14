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
import { parseScripts, orderVerifyScripts, pickVerifyScript, isFailure, summarizeFailure, buildFixInstruction, isSafeScriptName, verifyLoopStatus } from '../src/lib/verify.ts'
import { stripCodeFences, extractJsonObject } from '../electron/lib/aiParse.ts'
import {
  severityOf, flattenMessage, displayPartsToText, formatHover, isTsLike, samePath, chooseProject,
  applyTextEdits, offsetToLine, lineTextAt, isValidIdentifier,
} from '../electron/lib/tsLsp.ts'
import { toWorkspaceRelative, buildRenamePlan } from '../src/lib/rename.ts'
import { mergeDiagnostics, normalizeMessage, summarizeDiagnostics } from '../src/lib/diagnostics.ts'
import {
  parseDeps, depsMet, canReview, buildDispatchPrompt, sweepAction, decomposeAction,
  reviewSweepAction, planDispatches, planReviews, readyForSynthesis, planMessageDelivery,
  isWakeEvent,
  type ConductorTask,
} from '../src/lib/conductor.ts'
import { scoreVoice, rankVoices, pickVoice, cleanForSpeech, chunkForSpeech, type VoiceLike } from '../src/lib/voices.ts'
import { findPathLinks, isAbsolutePathLike, candidateAbsolutePaths } from '../src/lib/terminalLinks.ts'
import { isIndexablePath, planIncrementalUpdate, mergeIndexEntries } from '../src/lib/indexUpdate.ts'
import { findDevServerUrl } from '../src/lib/devServerUrl.ts'
import { SWARM_RECIPES, buildRecipeLayout, type BuiltLeaf, type BuiltGroup } from '../src/lib/recipes.ts'
import {
  escapeHtml, summarizeEvent, buildSessionStats, formatDuration, compactNumber,
  exportFileBase, agentPalette, renderSessionMarkdown, renderSessionHtml,
  type ExportEvent,
} from '../src/lib/sessionExport.ts'

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
  alreadyNudged: false, dispatchedAt: 0, now: 10_000, stallMs: 30_000,
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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
