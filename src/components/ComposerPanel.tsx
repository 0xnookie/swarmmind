import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useWorkspaceStore } from '../store/workspace'
import { lineDiff } from '../lib/lineDiff'
import { fuzzyRank } from '../lib/fuzzy'
import { tokenize, rankDocs, rankByEmbedding, fuseRankings } from '../lib/retrieval'
import { embeddingsReady, embedTexts, preloadEmbedder } from '../lib/embed'
import { buildIndex, loadIndex, queryIndex } from '../lib/codeIndex'
import { orderVerifyScripts, pickVerifyScript, isFailure, summarizeFailure, buildFixInstruction, verifyLoopStatus } from '../lib/verify'

// Cap autonomous fix attempts so the loop is always bounded (can't spin/cost forever).
const MAX_AUTOFIX_ROUNDS = 3
import { renderDiffRows } from './DiffRows'

// Multi-file Composer (Cursor's "Composer") — describe a change in natural
// language and the AI proposes coordinated edits across several files at once.
// The plan comes back from `swarmAgent:compose` as full new file contents; this
// panel diffs each against the current file, lets the user pick which to apply,
// and writes the selected ones (creating parents as needed).

interface Change {
  path: string
  action: string // 'edit' | 'create'
  content: string
}

type Phase = 'idle' | 'loading' | 'result'

export function ComposerPanel() {
  const t = useT()
  const rootPath = useWorkspaceStore((s) => s.workspace?.rootPath ?? null)
  const editorTabs = useWorkspaceStore((s) => s.editorTabs)
  const setEditorTabs = useWorkspaceStore((s) => s.setEditorTabs)
  const toggleCheckpoints = useWorkspaceStore((s) => s.toggleCheckpoints)
  const composerSeed = useWorkspaceStore((s) => s.composerSeed)
  const clearComposerSeed = useWorkspaceStore((s) => s.clearComposerSeed)

  const [instruction, setInstruction] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState('')
  const [changes, setChanges] = useState<Change[]>([])
  const [originals, setOriginals] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [applied, setApplied] = useState(false)
  // Snapshot the workspace before applying so the whole multi-file change is
  // reversible in one action via the Checkpoints panel. 'saved' | 'skipped' |
  // 'unavailable' (e.g. not a git repo) is shown in the applied banner.
  const [snapshot, setSnapshot] = useState(true)
  const [checkpointState, setCheckpointState] = useState<'saved' | 'skipped' | 'unavailable'>('skipped')

  // Context files included with the request (relative path → content).
  const [context, setContext] = useState<{ path: string; content: string }[]>([])
  const [allFiles, setAllFiles] = useState<string[]>([])
  const [addQuery, setAddQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const filesLoaded = useRef(false)

  const relOf = (absOrName: string) => absOrName.replace(/\\/g, '/')

  // Seed context with the currently open (text) editor tabs.
  useEffect(() => {
    if (!rootPath) return
    const rootFwd = rootPath.replace(/\\/g, '/')
    const seeded = editorTabs
      .filter((tab) => !tab.image)
      .map((tab) => {
        const rel = relOf(tab.path).startsWith(rootFwd + '/')
          ? relOf(tab.path).slice(rootFwd.length + 1)
          : relOf(tab.name)
        return { path: rel, content: tab.content }
      })
    setContext(seeded)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  // Consume a one-shot seed (e.g. from the editor's "Rename across files"):
  // prefill the instruction and load its context files, then clear it so it
  // doesn't re-apply on the next open.
  useEffect(() => {
    if (!composerSeed || !rootPath) return
    setInstruction(composerSeed.instruction)
    const rootFwd = rootPath.replace(/\\/g, '/')

    // Pre-built plan (e.g. one-click apply from a chat reply): skip the model and
    // go straight to the diff/apply UI with the exact changes provided. Resolve
    // each file's current content for diffing ('' for a create / unreadable file).
    if (composerSeed.plan && composerSeed.plan.changes.length) {
      const ch = composerSeed.plan.changes
      setSummary(composerSeed.plan.summary ?? '')
      setChanges(ch)
      setSelected(Object.fromEntries(ch.map((c) => [c.path, true])))
      setExpanded(Object.fromEntries(ch.map((c) => [c.path, ch.length <= 3])))
      setApplied(false)
      setError(null)
      Promise.all(
        ch.map(async (c) => {
          if (c.action === 'create') return [c.path, ''] as const
          try {
            return [c.path, await window.swarmmind.fsReadFile(`${rootFwd}/${c.path}`)] as const
          } catch {
            return [c.path, ''] as const
          }
        }),
      ).then((pairs) => {
        setOriginals(Object.fromEntries(pairs))
        setPhase('result')
      })
      clearComposerSeed()
      return
    }

    Promise.all(
      composerSeed.contextPaths.map(async (rel) => {
        try {
          return { path: rel, content: await window.swarmmind.fsReadFile(`${rootFwd}/${rel}`) }
        } catch {
          return null
        }
      }),
    ).then((loaded) => {
      const valid = loaded.filter((x): x is { path: string; content: string } => x !== null)
      setContext((cur) => {
        const have = new Set(cur.map((c) => c.path))
        return [...cur, ...valid.filter((v) => !have.has(v.path))]
      })
    })
    clearComposerSeed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composerSeed, rootPath])

  const loadFileIndex = () => {
    if (filesLoaded.current || !rootPath) return
    filesLoaded.current = true
    window.swarmmind
      .fsListFiles(rootPath, 4000)
      .then((files) => setAllFiles(files.map((f) => f.replace(/\\/g, '/'))))
      .catch(() => {})
  }

  const addSuggestions = useMemo(() => {
    if (!addQuery.trim()) return []
    const have = new Set(context.map((c) => c.path))
    return fuzzyRank(
      allFiles.filter((f) => !have.has(f)),
      addQuery,
      (f) => f,
      8,
    )
  }, [addQuery, allFiles, context])

  const addContextFile = async (rel: string) => {
    if (!rootPath) return
    try {
      const abs = `${rootPath.replace(/\\/g, '/')}/${rel}`
      const content = await window.swarmmind.fsReadFile(abs)
      setContext((c) => (c.some((x) => x.path === rel) ? c : [...c, { path: rel, content }]))
    } catch {
      /* unreadable — ignore */
    }
    setAddQuery('')
    setAddOpen(false)
  }

  const removeContext = (rel: string) => setContext((c) => c.filter((x) => x.path !== rel))

  // Persistent whole-repo semantic index (build once, reused by "Suggest relevant").
  const [indexing, setIndexing] = useState<{ done: number; total: number } | null>(null)
  const [indexStats, setIndexStats] = useState<{ files: number; chunks: number } | null>(null)
  const buildSemanticIndex = async () => {
    if (!rootPath || indexing) return
    setIndexing({ done: 0, total: 0 })
    try {
      const stats = await buildIndex(rootPath, (done, total) => setIndexing({ done, total }))
      setIndexStats(stats)
    } catch {
      setIndexStats(null) /* embeddings unavailable / offline */
    } finally {
      setIndexing(null)
    }
  }

  // Auto-context: grep the workspace for the instruction's salient terms, then
  // BM25-rank the matched files (by their matched-line snippets) and add the most
  // relevant ones — so the user doesn't have to hand-pick context. Bounded: only
  // files that grep-match a query term are ever read.
  const [suggesting, setSuggesting] = useState(false)
  const suggestRelevant = async () => {
    if (!rootPath || suggesting) return
    const terms = Array.from(new Set(tokenize(instruction)))
      .sort((a, b) => b.length - a.length)
      .slice(0, 6)
    if (terms.length === 0) return
    setSuggesting(true)
    try {
      const snippets = new Map<string, string[]>()
      const results = await Promise.all(
        terms.map((term) => window.swarmmind.fsSearchFiles(rootPath, term, '', 60).catch(() => [])),
      )
      for (const matches of results) {
        for (const m of matches) {
          const rel = m.path.replace(/\\/g, '/')
          const arr = snippets.get(rel) ?? []
          arr.push(m.text)
          snippets.set(rel, arr)
        }
      }
      const have = new Set(context.map((c) => c.path))
      const docs = Array.from(snippets.entries())
        .filter(([path]) => !have.has(path))
        .map(([path, lines]) => ({ path, text: lines.join('\n') }))

      // Combine up to three rankings via reciprocal-rank fusion:
      //  • lexical (BM25 over grep snippets) — always available, instant;
      //  • grep-embedding (semantic over the same grep candidates) — when warm;
      //  • the persistent whole-repo vector index — finds relevant files that
      //    don't even grep-match the query terms (the real semantic win).
      const lexical = rankDocs(instruction, docs, 12)
      const rankings = [lexical]
      if (embeddingsReady() && docs.length > 0) {
        try {
          const [qVec, ...docVecs] = await embedTexts([instruction, ...docs.map((d) => d.text)])
          const vectorDocs = docs.map((d, i) => ({ path: d.path, vector: docVecs[i] }))
          rankings.push(rankByEmbedding(qVec, vectorDocs, 12))
        } catch {
          /* embedding failed — keep lexical */
        }
      } else {
        void preloadEmbedder()
      }
      // Whole-repo semantic index, if one has been built. Best-effort.
      try {
        const index = await loadIndex(rootPath)
        if (index && embeddingsReady()) {
          const repoHits = (await queryIndex(index, instruction, 12)).filter((r) => !have.has(r.path))
          if (repoHits.length) rankings.push(repoHits)
        }
      } catch {
        /* no index / embedding unavailable — skip */
      }
      const top = rankings.length === 1 ? lexical.slice(0, 6) : fuseRankings(rankings, 6)

      const loaded = await Promise.all(
        top.map(async ({ path }) => {
          try {
            return { path, content: await window.swarmmind.fsReadFile(`${rootPath.replace(/\\/g, '/')}/${path}`) }
          } catch {
            return null
          }
        }),
      )
      const valid = loaded.filter((x): x is { path: string; content: string } => x !== null)
      setContext((cur) => {
        const cure = new Set(cur.map((c) => c.path))
        return [...cur, ...valid.filter((v) => !cure.has(v.path))]
      })
    } finally {
      setSuggesting(false)
    }
  }

  const generate = async (instructionOverride?: string) => {
    const instr = instructionOverride ?? instruction
    if (!instr.trim() || !rootPath) return
    if (instructionOverride) setInstruction(instructionOverride)
    setPhase('loading')
    setError(null)
    setApplied(false)
    setVerify(null)
    const res = await window.swarmmind.swarmAgentCompose({
      instruction: instr,
      // Cap each context file so a few large files can't blow the request.
      files: context.map((c) => ({ path: c.path, content: c.content.slice(0, 16000) })),
    })
    if (res.error || !res.changes) {
      setError(res.error === 'no-key' ? t('composer.noKey') : res.error ?? t('composer.noChanges'))
      setPhase('idle')
      return
    }
    const ch = res.changes
    setSummary(res.summary ?? '')
    setChanges(ch)
    setSelected(Object.fromEntries(ch.map((c) => [c.path, true])))
    setExpanded(Object.fromEntries(ch.map((c) => [c.path, ch.length <= 3])))
    // Resolve original contents for diffing: prefer a context file, else read it,
    // else treat as a new (empty) file.
    const ctxMap = new Map(context.map((c) => [c.path, c.content]))
    const orig: Record<string, string> = {}
    for (const c of ch) {
      if (c.action === 'create') {
        orig[c.path] = ''
      } else if (ctxMap.has(c.path)) {
        orig[c.path] = ctxMap.get(c.path)!
      } else {
        try {
          orig[c.path] = await window.swarmmind.fsReadFile(`${rootPath.replace(/\\/g, '/')}/${c.path}`)
        } catch {
          orig[c.path] = ''
        }
      }
    }
    setOriginals(orig)
    setPhase('result')
  }

  const selectedCount = changes.filter((c) => selected[c.path]).length

  // Write a set of changes to disk and reflect them in open editor tabs. Returns
  // the paths that failed to write. Shared by manual apply and the auto-fix loop.
  const writeChanges = async (toApply: Change[]): Promise<string[]> => {
    if (!rootPath) return toApply.map((c) => c.path)
    const rootFwd = rootPath.replace(/\\/g, '/')
    const failures: string[] = []
    for (const c of toApply) {
      try {
        await window.swarmmind.fsWriteFile(`${rootFwd}/${c.path}`, c.content)
      } catch {
        failures.push(c.path)
      }
    }
    const appliedPaths = new Set(toApply.filter((c) => !failures.includes(c.path)).map((c) => c.path))
    if (appliedPaths.size) {
      setEditorTabs(
        editorTabs.map((tab) => {
          const rel = relOf(tab.path).startsWith(rootFwd + '/')
            ? relOf(tab.path).slice(rootFwd.length + 1)
            : relOf(tab.name)
          const change = toApply.find((c) => c.path === rel)
          return change && appliedPaths.has(rel) ? { ...tab, content: change.content, dirty: false } : tab
        }),
      )
    }
    return failures
  }

  const apply = async () => {
    if (!rootPath) return
    const toApply = changes.filter((c) => selected[c.path])

    // Safety snapshot before touching files, so the whole change (including any
    // autonomous fix rounds that follow) can be rolled back as one checkpoint.
    if (snapshot) {
      const label = `Composer: ${(summary || instruction).slice(0, 60)}`
      const res = await window.swarmmind.checkpointCreate(label, 'composer')
      setCheckpointState(res && 'error' in res ? 'unavailable' : 'saved')
    } else {
      setCheckpointState('skipped')
    }

    const failures = await writeChanges(toApply)
    if (failures.length) setError(t('composer.applyFailed', { files: failures.join(', ') }))
    setApplied(true)
    // Offer to verify with one of the workspace's own npm scripts (typecheck etc),
    // then — if auto-fix is enabled — kick off the autonomous verify→fix loop.
    const script = await loadVerifyScripts()
    if (autoFix && script) void runVerify(script)
  }

  // ── Verify → fix loop (the safe core of "agent-mode iteration") ─────────────
  // After applying, run one of the workspace's OWN npm scripts; on failure, feed
  // the error summary back into a fresh Composer generation so the model fixes
  // its own change. Human-in-the-loop: every step is an explicit click.
  const [verifyScripts, setVerifyScripts] = useState<string[]>([])
  const [verifyScript, setVerifyScript] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [verify, setVerify] = useState<{ ok: boolean; code: number; summary: string } | null>(null)
  // Opt-in autonomous fixing: when on, a failed verify auto-generates+applies a
  // fix and re-verifies, up to MAX_AUTOFIX_ROUNDS. Default OFF — it writes files
  // and spends tokens without per-step confirmation. `autoState` shows progress.
  const [autoFix, setAutoFix] = useState(false)
  const [autoState, setAutoState] = useState<{ round: number; phase: 'fixing' | 'verifying' } | null>(null)

  const loadVerifyScripts = async (): Promise<string> => {
    if (!rootPath) return verifyScript
    try {
      const scripts = verifyScripts.length ? verifyScripts : orderVerifyScripts(await window.swarmmind.verifyScripts(rootPath))
      if (!verifyScripts.length) setVerifyScripts(scripts)
      const chosen = verifyScript || pickVerifyScript(scripts) || scripts[0] || ''
      if (chosen !== verifyScript) setVerifyScript(chosen)
      return chosen
    } catch {
      return verifyScript /* no package.json / unreadable — verify stays hidden */
    }
  }

  const runVerify = async (scriptOverride?: string) => {
    const script = scriptOverride || verifyScript
    if (!rootPath || !script || verifying) return
    setVerifying(true)
    setVerify(null)
    try {
      const res = await window.swarmmind.verifyRun(rootPath, script)
      if (res.error) {
        setVerify({ ok: false, code: res.code, summary: `Could not run: ${res.error}` })
        return
      }
      const ok = !isFailure(res)
      const summary = ok ? '' : summarizeFailure(res, 40)
      setVerify({ ok, code: res.code, summary })
      if (!ok && autoFix) await autoFixLoop(script, summary)
    } finally {
      setVerifying(false)
    }
  }

  // Feed a failure back to the model to self-correct. Manual: one click → one fix
  // plan (reuses the displayed plan pipeline so the user reviews/applies it).
  const fixWithErrors = () => {
    if (!verify || verify.ok) return
    generate(buildFixInstruction(instruction, verifyScript, verify.summary))
  }

  // Autonomous loop: compose a fix from the failure, apply it, re-verify, repeat
  // up to the cap. Bounded by MAX_AUTOFIX_ROUNDS via verifyLoopStatus. The initial
  // snapshot from apply() covers every round, so the whole loop is one rollback.
  const autoFixLoop = async (script: string, firstSummary: string) => {
    if (!rootPath) return
    let summary = firstSummary
    for (let round = 1; round <= MAX_AUTOFIX_ROUNDS; round++) {
      setAutoState({ round, phase: 'fixing' })
      const fixInstr = buildFixInstruction(instruction, script, summary)
      const res = await window.swarmmind.swarmAgentCompose({
        instruction: fixInstr,
        files: context.map((c) => ({ path: c.path, content: c.content.slice(0, 16000) })),
      })
      if (res.error || !res.changes || res.changes.length === 0) break
      const ch = res.changes
      setSummary(res.summary ?? '')
      setChanges(ch)
      setSelected(Object.fromEntries(ch.map((c) => [c.path, true])))
      setExpanded(Object.fromEntries(ch.map((c) => [c.path, ch.length <= 3])))
      // Resolve originals (current on-disk content) so the diff view reflects this round.
      const orig: Record<string, string> = {}
      for (const c of ch) {
        try {
          orig[c.path] = await window.swarmmind.fsReadFile(`${rootPath.replace(/\\/g, '/')}/${c.path}`)
        } catch {
          orig[c.path] = ''
        }
      }
      setOriginals(orig)
      await writeChanges(ch)

      setAutoState({ round, phase: 'verifying' })
      const out = await window.swarmmind.verifyRun(rootPath, script)
      const ok = !out.error && !isFailure(out)
      summary = ok ? '' : out.error ? `Could not run: ${out.error}` : summarizeFailure(out, 40)
      setVerify({ ok, code: out.code, summary })
      if (verifyLoopStatus(round, MAX_AUTOFIX_ROUNDS, ok) !== 'retry') break
    }
    setAutoState(null)
  }

  if (!rootPath) {
    return <div style={styles.empty}>{t('file.openFirst')}</div>
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <span style={styles.title}>✦ {t('composer.title')}</span>
        <span style={styles.subtitle}>{t('composer.subtitle')}</span>
      </div>

      {/* Prompt */}
      <div style={styles.promptArea}>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (phase !== 'loading') generate()
            }
          }}
          placeholder={t('composer.placeholder')}
          rows={3}
          style={styles.textarea}
        />

        {/* Context files */}
        <div style={styles.contextRow}>
          <span style={styles.contextLabel}>{t('composer.context')}:</span>
          {context.map((c) => (
            <span key={c.path} style={styles.chip} title={c.path}>
              {c.path.slice(c.path.lastIndexOf('/') + 1)}
              <button style={styles.chipX} onClick={() => removeContext(c.path)}>
                ×
              </button>
            </span>
          ))}
          <div style={{ position: 'relative' }}>
            <button
              style={styles.addBtn}
              onClick={() => {
                loadFileIndex()
                setAddOpen((o) => !o)
              }}
            >
              + {t('composer.addFile')}
            </button>
            {addOpen && (
              <div style={styles.addMenu}>
                <input
                  autoFocus
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  placeholder={t('composer.searchFiles')}
                  style={styles.addInput}
                />
                {addSuggestions.map((f) => (
                  <div key={f} style={styles.addItem} onMouseDown={() => addContextFile(f)}>
                    <span style={{ fontWeight: 600 }}>{f.slice(f.lastIndexOf('/') + 1)}</span>
                    <span style={styles.addItemDir}>{f.slice(0, f.lastIndexOf('/') + 1)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            style={{ ...styles.addBtn, opacity: !instruction.trim() || suggesting ? 0.5 : 1 }}
            disabled={!instruction.trim() || suggesting}
            onClick={suggestRelevant}
            title={t('composer.suggestHint')}
          >
            {suggesting ? t('composer.suggesting') : `✦ ${t('composer.suggest')}`}
          </button>
          <button
            style={{ ...styles.addBtn, opacity: indexing ? 0.5 : 1 }}
            disabled={!!indexing}
            onClick={buildSemanticIndex}
            title={t('composer.indexHint')}
          >
            {indexing
              ? indexing.total
                ? t('composer.indexing', { done: indexing.done, total: indexing.total })
                : t('composer.indexingStart')
              : indexStats
                ? t('composer.reindex')
                : t('composer.buildIndex')}
          </button>
          {indexStats && !indexing && (
            <span style={styles.contextLabel}>
              {t('composer.indexStats', { files: indexStats.files, chunks: indexStats.chunks })}
            </span>
          )}
        </div>

        <div style={styles.actionRow}>
          <span style={styles.hint}>{t('composer.hint')}</span>
          <button
            style={{ ...styles.generateBtn, opacity: phase === 'loading' || !instruction.trim() ? 0.5 : 1 }}
            disabled={phase === 'loading' || !instruction.trim()}
            onClick={() => generate()}
          >
            {phase === 'loading' ? t('composer.generating') : t('composer.generate')}
          </button>
        </div>

        {error && <div style={styles.error}>{error}</div>}
      </div>

      {/* Results */}
      {phase === 'result' && (
        <div style={styles.results}>
          {summary && <div style={styles.summary}>{summary}</div>}

          {applied ? (
            <>
              <div style={styles.appliedBanner}>
                <span>✓ {t('composer.applied', { n: selectedCount })}</span>
                {checkpointState === 'saved' && (
                  <button style={styles.bannerLink} onClick={toggleCheckpoints}>
                    {t('composer.checkpointSaved')}
                  </button>
                )}
                {checkpointState === 'unavailable' && (
                  <span style={styles.bannerNote}>{t('composer.checkpointUnavailable')}</span>
                )}
              </div>

              {/* Verify → fix loop */}
              {verifyScripts.length > 0 && (
                <div style={styles.verifyBox}>
                  <div style={styles.verifyRow}>
                    <span style={styles.verifyLabel}>{t('composer.verify')}</span>
                    <select
                      value={verifyScript}
                      onChange={(e) => setVerifyScript(e.target.value)}
                      disabled={verifying}
                      style={styles.verifySelect}
                    >
                      {verifyScripts.map((s) => (
                        <option key={s} value={s}>
                          npm run {s}
                        </option>
                      ))}
                    </select>
                    <button
                      style={{ ...styles.toggleBtn, opacity: verifying || !verifyScript ? 0.5 : 1 }}
                      disabled={verifying || !verifyScript}
                      onClick={() => runVerify()}
                    >
                      {verifying ? t('composer.verifying') : t('composer.runVerify')}
                    </button>
                    <label style={styles.snapshotToggle} title={t('composer.autoFixHint', { n: MAX_AUTOFIX_ROUNDS })}>
                      <input type="checkbox" checked={autoFix} onChange={(e) => setAutoFix(e.target.checked)} disabled={verifying} />
                      {t('composer.autoFix')}
                    </label>
                  </div>
                  {autoState && (
                    <div style={styles.verifyResult}>
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                        ✦ {t('composer.autoFixProgress', { round: autoState.round, max: MAX_AUTOFIX_ROUNDS })}
                        {autoState.phase === 'fixing' ? ` — ${t('composer.autoFixFixing')}` : ` — ${t('composer.autoFixVerifying')}`}
                      </span>
                    </div>
                  )}
                  {verify && (
                    <div style={styles.verifyResult}>
                      {verify.ok ? (
                        <span style={{ color: '#7cba7c', fontWeight: 600 }}>✓ {t('composer.verifyPass')}</span>
                      ) : (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span style={{ color: '#e07a7a', fontWeight: 600 }}>
                              ✗ {t('composer.verifyFail', { code: verify.code })}
                            </span>
                            <button style={styles.applyBtn} onClick={fixWithErrors}>
                              {t('composer.fixErrors')}
                            </button>
                          </div>
                          {verify.summary && <pre style={styles.verifyOutput}>{verify.summary}</pre>}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <div style={styles.applyBar}>
              <span style={styles.applyCount}>
                {t('composer.changeCount', { n: changes.length, sel: selectedCount })}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <label style={styles.snapshotToggle} title={t('composer.snapshotHint')}>
                  <input
                    type="checkbox"
                    checked={snapshot}
                    onChange={(e) => setSnapshot(e.target.checked)}
                  />
                  {t('composer.snapshot')}
                </label>
                <button
                  style={{ ...styles.applyBtn, opacity: selectedCount ? 1 : 0.5 }}
                  disabled={!selectedCount}
                  onClick={apply}
                >
                  {t('composer.apply', { n: selectedCount })}
                </button>
              </div>
            </div>
          )}

          <div style={styles.changeList}>
            {changes.map((c) => {
              const isOpen = expanded[c.path]
              const diff = isOpen ? lineDiff(originals[c.path] ?? '', c.content) : []
              const adds = diff.filter((d) => d.t === 'add').length
              const dels = diff.filter((d) => d.t === 'del').length
              return (
                <div key={c.path} style={styles.changeCard}>
                  <div style={styles.changeHead}>
                    <input
                      type="checkbox"
                      checked={!!selected[c.path]}
                      disabled={applied}
                      onChange={(e) => setSelected((s) => ({ ...s, [c.path]: e.target.checked }))}
                    />
                    <span
                      style={{
                        ...styles.actionBadge,
                        background: c.action === 'create' ? 'var(--accent)' : 'var(--bg-panel)',
                        color: c.action === 'create' ? 'var(--accent-fg)' : 'var(--text-secondary)',
                      }}
                    >
                      {c.action === 'create' ? t('composer.new') : t('composer.edit')}
                    </span>
                    <span style={styles.changePath} title={c.path} onClick={() => setExpanded((s) => ({ ...s, [c.path]: !isOpen }))}>
                      {c.path}
                    </span>
                    {isOpen && (
                      <span style={styles.stat}>
                        <span style={{ color: '#7cba7c' }}>+{adds}</span>{' '}
                        <span style={{ color: '#e07a7a' }}>−{dels}</span>
                      </span>
                    )}
                    <button style={styles.toggleBtn} onClick={() => setExpanded((s) => ({ ...s, [c.path]: !isOpen }))}>
                      {isOpen ? t('composer.hideDiff') : t('composer.showDiff')}
                    </button>
                  </div>
                  {isOpen && (
                    <pre style={styles.diff}>{renderDiffRows(diff)}</pre>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  root: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, background: 'var(--bg-base)', overflow: 'hidden' },
  empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 13 },
  header: { padding: '12px 16px 8px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'baseline', gap: 10 },
  title: { fontSize: 14, fontWeight: 700, color: 'var(--accent)' },
  subtitle: { fontSize: 11.5, color: 'var(--text-muted)' },
  promptArea: { padding: 14, borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 10 },
  textarea: {
    width: '100%', boxSizing: 'border-box', resize: 'vertical', background: 'var(--bg-panel)',
    border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', padding: '9px 11px',
    fontSize: 13, fontFamily: 'inherit', outline: 'none',
  },
  contextRow: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  contextLabel: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 },
  chip: { display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 6px 0 8px', borderRadius: 11, background: 'var(--bg-elevated)', border: '1px solid var(--border)', fontSize: 11, color: 'var(--text-secondary)' },
  chipX: { border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0 },
  addBtn: { height: 22, padding: '0 9px', borderRadius: 11, border: '1px dashed var(--border)', background: 'transparent', color: 'var(--text-secondary)', fontSize: 11, cursor: 'pointer' },
  addMenu: { position: 'absolute', top: '110%', left: 0, zIndex: 30, width: 320, background: 'var(--bg-elevated)', border: '1px solid var(--border-active)', borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', overflow: 'hidden' },
  addInput: { width: '100%', boxSizing: 'border-box', border: 'none', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-base)', color: 'var(--text-primary)', padding: '7px 10px', fontSize: 12, outline: 'none' },
  addItem: { display: 'flex', alignItems: 'baseline', gap: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 11.5, color: 'var(--text-primary)' },
  addItemDir: { fontSize: 10.5, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  actionRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  hint: { fontSize: 11, color: 'var(--text-dim)' },
  generateBtn: { height: 30, padding: '0 16px', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', background: 'var(--accent)', color: 'var(--accent-fg)' },
  error: { color: '#e57373', fontSize: 12 },
  results: { flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' },
  summary: { padding: '12px 16px', fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.5, borderBottom: '1px solid var(--border-subtle)' },
  applyBar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', position: 'sticky', top: 0, background: 'var(--bg-base)', borderBottom: '1px solid var(--border-subtle)', zIndex: 5 },
  applyCount: { fontSize: 12, color: 'var(--text-muted)' },
  applyBtn: { height: 30, padding: '0 16px', border: 'none', borderRadius: 6, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', background: 'var(--accent)', color: 'var(--accent-fg)' },
  appliedBanner: { padding: '10px 16px', color: '#7cba7c', fontSize: 12.5, fontWeight: 600, borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 12 },
  bannerLink: { border: 'none', background: 'transparent', color: 'var(--accent)', cursor: 'pointer', fontSize: 12, fontWeight: 600, textDecoration: 'underline', padding: 0 },
  bannerNote: { color: 'var(--text-muted)', fontSize: 11.5, fontWeight: 400 },
  snapshotToggle: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' },
  changeList: { display: 'flex', flexDirection: 'column' },
  changeCard: { borderBottom: '1px solid var(--border-subtle)' },
  changeHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px' },
  actionBadge: { fontSize: 9.5, fontWeight: 700, padding: '1px 6px', borderRadius: 3, textTransform: 'uppercase', letterSpacing: 0.4 },
  changePath: { flex: 1, fontSize: 12, color: 'var(--text-primary)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono, monospace)' },
  stat: { fontSize: 11, fontFamily: 'var(--font-mono, monospace)' },
  toggleBtn: { border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-secondary)', borderRadius: 4, fontSize: 10.5, padding: '2px 8px', cursor: 'pointer' },
  diff: { margin: 0, padding: '6px 16px 10px', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'var(--font-mono, monospace)', maxHeight: 340, overflow: 'auto', background: 'var(--bg-panel)' },
  verifyBox: { padding: '10px 16px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 8 },
  verifyRow: { display: 'flex', alignItems: 'center', gap: 8 },
  verifyLabel: { fontSize: 11.5, fontWeight: 600, color: 'var(--text-secondary)' },
  verifySelect: { background: 'var(--bg-panel)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 11.5, padding: '3px 6px', outline: 'none' },
  verifyResult: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 },
  verifyOutput: { margin: 0, padding: '8px 10px', fontSize: 11, lineHeight: 1.45, fontFamily: 'var(--font-mono, monospace)', maxHeight: 220, overflow: 'auto', background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 6, whiteSpace: 'pre-wrap' },
}
