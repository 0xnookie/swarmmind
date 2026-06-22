import React, { useState } from 'react'

// A tiny, dependency-free, XSS-safe Markdown renderer for SwarmAgent replies.
//
// Why hand-rolled: the assistant frequently answers in Markdown (code blocks,
// lists, bold, inline `code`, links). Rendering that as raw text — as the chat
// did before — looks broken for a coding assistant. We don't want to pull in a
// full Markdown library (the project keeps its dependency tree lean and ships it
// into the asar), and we must never use dangerouslySetInnerHTML on model output.
// So this parses a practical subset into React elements: fenced code blocks
// (with a copy button + language label), ATX headings, unordered/ordered lists,
// blockquotes, horizontal rules, and paragraphs — with inline bold, italic,
// strikethrough, inline code, and links. Anything it doesn't recognise falls
// through as plain text, so output is always at least as readable as before.

// ── Inline parsing ──────────────────────────────────────────────────────────
// Splits a line into React nodes, honouring `code`, **bold**, *italic*,
// ~~strike~~, and [text](url). Inline code is tokenised first so its contents
// are never re-interpreted as other markup.
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  // Split on inline code spans first; even indices are non-code, odd are code.
  const codeParts = text.split(/(`[^`]+`)/g)
  codeParts.forEach((part, ci) => {
    if (!part) return
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      out.push(<code key={`${keyPrefix}-c${ci}`} className="md-code-inline">{part.slice(1, -1)}</code>)
      return
    }
    out.push(...renderEmphasis(part, `${keyPrefix}-${ci}`))
  })
  return out
}

// Handles links + emphasis (bold/italic/strike) on a non-code text fragment.
// Uses a single combined regex and walks the matches in order.
const INLINE_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|\*([^*]+)\*|_([^_]+)_/g

function renderEmphasis(text: string, keyPrefix: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyPrefix}-e${i++}`
    if (m[1] !== undefined) {
      out.push(<a key={key} href={m[2]} target="_blank" rel="noreferrer noopener" className="md-link">{m[1]}</a>)
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<strong key={key}>{m[3] ?? m[4]}</strong>)
    } else if (m[5] !== undefined) {
      out.push(<del key={key}>{m[5]}</del>)
    } else {
      out.push(<em key={key}>{m[6] ?? m[7]}</em>)
    }
    last = INLINE_RE.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// ── Code block with copy button ─────────────────────────────────────────────
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }).catch(() => {})
  }
  return (
    <div className="md-codeblock">
      <div className="md-codeblock-bar">
        <span className="md-codeblock-lang">{lang || 'text'}</span>
        <button className="md-codeblock-copy" onClick={copy} type="button">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  )
}

// ── Block parsing ───────────────────────────────────────────────────────────
type Block =
  | { kind: 'code'; code: string; lang?: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'p'; text: string }

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Fenced code block
    const fence = line.match(/^```(.*)$/)
    if (fence) {
      const lang = fence[1].trim()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++ }
      i++ // skip closing fence
      blocks.push({ kind: 'code', code: body.join('\n'), lang })
      continue
    }
    // Blank line
    if (!line.trim()) { i++; continue }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { blocks.push({ kind: 'heading', level: h[1].length, text: h[2].trim() }); i++; continue }
    // Horizontal rule
    if (/^(\*\*\*|---|___)\s*$/.test(line)) { blocks.push({ kind: 'hr' }); i++; continue }
    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++
      }
      blocks.push({ kind: 'ul', items })
      continue
    }
    // Ordered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++
      }
      blocks.push({ kind: 'ol', items })
      continue
    }
    // Blockquote
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { body.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }
    // Paragraph: gather consecutive non-blank, non-special lines
    const para: string[] = []
    while (
      i < lines.length && lines[i].trim() &&
      !/^```/.test(lines[i]) && !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) && !/^(\*\*\*|---|___)\s*$/.test(lines[i])
    ) { para.push(lines[i]); i++ }
    blocks.push({ kind: 'p', text: para.join('\n') })
  }
  return blocks
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className="md">
      {blocks.map((b, bi) => {
        switch (b.kind) {
          case 'code':
            return <CodeBlock key={bi} code={b.code} lang={b.lang} />
          case 'heading': {
            const Tag = (`h${Math.min(b.level + 2, 6)}`) as keyof React.JSX.IntrinsicElements
            return <Tag key={bi} className="md-heading">{renderInline(b.text, `h${bi}`)}</Tag>
          }
          case 'ul':
            return <ul key={bi} className="md-ul">{b.items.map((it, j) => <li key={j}>{renderInline(it, `ul${bi}-${j}`)}</li>)}</ul>
          case 'ol':
            return <ol key={bi} className="md-ol">{b.items.map((it, j) => <li key={j}>{renderInline(it, `ol${bi}-${j}`)}</li>)}</ol>
          case 'quote':
            return <blockquote key={bi} className="md-quote">{renderInline(b.text, `q${bi}`)}</blockquote>
          case 'hr':
            return <hr key={bi} className="md-hr" />
          default:
            return (
              <p key={bi} className="md-p">
                {b.text.split('\n').map((ln, j) => (
                  <React.Fragment key={j}>{j > 0 && <br />}{renderInline(ln, `p${bi}-${j}`)}</React.Fragment>
                ))}
              </p>
            )
        }
      })}
    </div>
  )
}
