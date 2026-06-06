function WorkspaceDot({ color }) {
  const fill = color === 'amber' ? '#f59e0b' : color === 'red' ? '#ef4444' : '#10b981';
  return <span style={{
    width: 8, height: 8, borderRadius: 9999, background: fill, flexShrink: 0,
    boxShadow: `0 0 0 0px ${fill}`,
  }} />;
}

function BadgePill({ kind, count }) {
  if (!count) return null;
  const styles = kind === 'unread'
    ? { bg: '#3a2f1f', fg: '#fbbf24' }
    : { bg: '#3a2218', fg: '#f87171' };
  return (
    <span style={{
      height: 18, padding: '0 6px',
      borderRadius: 9,
      background: styles.bg, color: styles.fg,
      fontSize: 11, fontWeight: 500,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      lineHeight: 1,
    }}>{count}</span>
  );
}

function WorkspaceRow({ ws, active, onClick }) {
  return (
    <div
      onClick={onClick}
      className={'ws-row' + (active ? ' active' : '')}
      style={{
        height: 36,
        padding: '0 12px',
        marginBottom: 1,
        display: 'flex', alignItems: 'center', gap: 10,
        cursor: 'pointer',
        background: active ? 'var(--bg-elevated)' : 'transparent',
        transition: 'background 150ms ease-out',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-elevated)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      <WorkspaceDot color={ws.dotColor} />
      <span style={{
        fontSize: 14, fontWeight: 500,
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{ws.name}</span>
      <div style={{ flex: 1 }} />
      <div className="ws-badges" style={{ display: 'flex', gap: 4 }}>
        <BadgePill kind="unread" count={ws.unread} />
        <BadgePill kind="alert" count={ws.alerts} />
      </div>
      <button
        className="ws-close icon-btn-sm"
        aria-label="Close workspace"
        onClick={e => e.stopPropagation()}
        style={{ width: 22, height: 22 }}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

function WorkspaceSidebar({ workspaces, activeId, onSelect }) {
  return (
    <aside style={{
      width: 260, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: 16,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        flexShrink: 0,
      }}>
        <span className="section-label">Workspaces</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button className="icon-btn-sm" aria-label="New workspace"><IconPlus size={16} /></button>
          <button className="icon-btn-sm" aria-label="Workspace menu"><IconChevronDown size={14} /></button>
        </div>
      </div>

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 12 }}>
        {workspaces.map(ws => (
          <WorkspaceRow
            key={ws.id}
            ws={ws}
            active={ws.id === activeId}
            onClick={() => onSelect(ws.id)}
          />
        ))}
      </div>

      {/* Footer (user) */}
      <div style={{
        borderTop: '1px solid var(--border-subtle)',
        padding: '10px 12px',
        display: 'flex', alignItems: 'center', gap: 10,
        flexShrink: 0,
      }}>
        <div style={{
          width: 24, height: 24, borderRadius: 9999,
          background: 'linear-gradient(135deg, #5a4a3a, #3d3530)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 600, color: 'var(--text-primary)',
        }}>AC</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.2 }}>alex.chen</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.3 }}>Pro · 3 devices</div>
        </div>
        <button className="icon-btn-sm" aria-label="User menu"><IconChevronDown size={14} /></button>
      </div>
    </aside>
  );
}

window.WorkspaceSidebar = WorkspaceSidebar;
