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
  parseDeps, depsMet, canReview, buildDispatchPrompt, sweepAction, decomposeAction,
  reviewSweepAction, planDispatches, planReviews, readyForSynthesis, planMessageDelivery,
  type ConductorTask,
} from '../src/lib/conductor.ts'
import { scoreVoice, rankVoices, pickVoice, cleanForSpeech, chunkForSpeech, type VoiceLike } from '../src/lib/voices.ts'

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

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
