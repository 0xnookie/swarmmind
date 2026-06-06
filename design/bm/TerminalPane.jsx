function TerminalPane({ running, paneIndex, hintIndex }) {
  const hint = hintExamples[(hintIndex + paneIndex) % hintExamples.length];

  return (
    <div style={{
      background: 'var(--bg-terminal)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 10,
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
      minHeight: 0,
    }}>
      {/* Header */}
      <div style={{
        height: 32, flexShrink: 0,
        background: 'var(--bg-elevated)',
        borderBottom: '1px solid var(--border-subtle)',
        padding: '0 10px',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <IconSparkles size={14} stroke={1.75} strokeColor="var(--accent)" />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Claude Code</span>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="icon-btn-sm" aria-label="Sparkles"><IconSparkles size={14} /></button>
          <button className="icon-btn-sm" aria-label="Maximize"><IconMaximize2 size={14} /></button>
          <button className="icon-btn-sm" aria-label="Split"><IconSplitH size={14} /></button>
          <button className="icon-btn-sm" aria-label="Minimize"><IconMinimize2 size={14} /></button>
          <button className="icon-btn-sm" aria-label="Close"><IconX size={14} /></button>
        </div>
      </div>

      {/* Body */}
      <div className="mono" style={{
        flex: 1,
        padding: 12,
        fontSize: 13,
        lineHeight: 1.5,
        overflow: 'hidden',
        minHeight: 0,
      }}>
        {running ? (
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            {/* tiny logo block */}
            <div style={{
              width: 28, height: 28, flexShrink: 0,
              borderRadius: 4,
              background: 'var(--accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#1a1816', fontWeight: 700, fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
            }}>※</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ color: 'var(--text-primary)' }}>Claude Code v2.1.128</div>
              <div style={{ color: 'var(--text-muted)' }}>Opus 4.7 (1M context) with xhigh effort</div>
              <div style={{ color: 'var(--text-muted)' }}>Claude Max</div>
              <div style={{ color: 'var(--text-muted)' }}>~/Desktop/bridgemind</div>
            </div>
          </div>
        ) : (
          <div style={{
            height: '100%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-dim)', fontSize: 12,
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <IconTerminal size={14} stroke={1.5} />
              <span>idle pane · ⌘N to start</span>
            </span>
          </div>
        )}
      </div>

      {running && (
        <>
          {/* Footer */}
          <div className="mono" style={{
            height: 28, flexShrink: 0,
            borderTop: '1px solid var(--border-subtle)',
            padding: '0 10px',
            display: 'flex', alignItems: 'center',
            fontSize: 13,
          }}>
            <span style={{ color: 'var(--status-warn)' }}>Found 1 settings issue</span>
            <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>/doctor for details</span>
          </div>

          {/* Hint row */}
          <div className="mono" style={{
            height: 24, flexShrink: 0,
            padding: '0 10px',
            display: 'flex', alignItems: 'center',
            fontSize: 13,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            <span style={{ color: 'var(--accent)', marginRight: 6 }}>&gt;</span>
            <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hint.replace(/^> ?/, '')}</span>
          </div>

          {/* Status strip */}
          <div className="mono" style={{
            flexShrink: 0,
            padding: '0 10px 8px',
            display: 'flex', flexDirection: 'column', gap: 2,
            fontSize: 11,
            lineHeight: 1.4,
          }}>
            <div>
              <span style={{ color: 'var(--text-dim)' }}>os </span>
              <span style={{ color: 'var(--text-dim)' }}>▪○ </span>
              <span style={{ color: 'var(--text-dim)' }}>bridgemind / </span>
              <span style={{ color: 'var(--text-muted)' }}>bridgemind</span>
              <span style={{ color: 'var(--text-muted)' }}>{'  |  '}</span>
              <span style={{ color: 'var(--text-muted)' }}>Opus 4.7 </span>
              <span style={{ color: 'var(--text-muted)', textDecoration: 'underline', textDecorationColor: 'var(--text-dim)' }}>(1M context)</span>
            </div>
            <div>
              <span style={{ color: 'var(--accent)' }}>auto mode on</span>
              <span style={{ color: 'var(--text-dim)' }}> (shift+tab to cycle)</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

window.TerminalPane = TerminalPane;
