function TitleBar({ workspaceName = 'bridgemind', onTogglePanel, panelOpen }) {
  return (
    <div style={{
      height: 38,
      flexShrink: 0,
      background: 'var(--bg-base)',
      borderBottom: '1px solid var(--border-subtle)',
      display: 'flex',
      alignItems: 'center',
      WebkitAppRegion: 'drag',
      userSelect: 'none',
    }}>
      {/* Traffic lights */}
      <div className="traffic-group" style={{
        display: 'flex', gap: 8, paddingLeft: 12, alignItems: 'center',
        WebkitAppRegion: 'no-drag',
      }}>
        <button aria-label="close" className="traffic" style={{ background: '#ff5f57' }}>
          <span className="glyph">×</span>
        </button>
        <button aria-label="minimize" className="traffic" style={{ background: '#febc2e' }}>
          <span className="glyph">−</span>
        </button>
        <button aria-label="maximize" className="traffic" style={{ background: '#28c840' }}>
          <span className="glyph">+</span>
        </button>
      </div>

      {/* Center-left brand + workspace */}
      <div style={{
        display: 'flex', alignItems: 'center', marginLeft: 16, gap: 0,
      }}>
        <div style={{
          width: 16, height: 16, borderRadius: 4,
          background: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#1a1816',
        }}>
          <IconBridge size={11} stroke={2.4} />
        </div>
        <span style={{
          marginLeft: 8, fontSize: 14, fontWeight: 500, color: 'var(--text-primary)',
        }}>BridgeMind</span>
        <span style={{ margin: '0 4px', color: 'var(--text-muted)', fontSize: 14 }}>›</span>
        <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--text-secondary)' }}>{workspaceName}</span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Right cluster */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, paddingRight: 12,
        WebkitAppRegion: 'no-drag',
      }}>
        <button className="icon-btn" aria-label="Grid layout"><IconLayoutGrid /></button>
        <button className="icon-btn" aria-label="Code view"><IconCode2 /></button>
        <button className="icon-btn" aria-label="Tools"><IconWrench /></button>
        <div style={{ width: 1, height: 12, background: 'var(--border-strong)', margin: '0 4px' }} />
        <button className="icon-btn" aria-label="Notifications" style={{ position: 'relative' }}>
          <IconBell />
          <span style={{
            position: 'absolute', top: 2, right: 2,
            minWidth: 14, height: 14, padding: '0 3px',
            borderRadius: 9999,
            background: '#ef4444',
            color: '#fff',
            fontSize: 9, fontWeight: 600, lineHeight: '14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: '1.5px solid var(--bg-base)',
          }}>12</span>
        </button>
        <button className="icon-btn" aria-label="Settings"><IconSettings /></button>
        <button className="icon-btn" aria-label="Toggle right panel" onClick={onTogglePanel}
          style={{ background: panelOpen ? 'var(--bg-elevated)' : undefined, color: panelOpen ? 'var(--text-secondary)' : undefined }}>
          <IconPanelRight />
        </button>
      </div>
    </div>
  );
}

window.TitleBar = TitleBar;
