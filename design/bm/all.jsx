
/* ===== bm/icons.jsx ===== */
// Inline SVG icons (lucide-inspired, drawn from scratch). 1.75 stroke, round caps.
const Icon = ({ d, size = 16, stroke = 1.75, fill = 'none', strokeColor = 'currentColor', children, viewBox = '0 0 24 24', style }) => (
  <svg width={size} height={size} viewBox={viewBox} fill={fill} stroke={strokeColor}
    strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    style={{ display: 'block', flexShrink: 0, ...style }}>
    {d ? <path d={d} /> : children}
  </svg>
);

const IconLayoutGrid = (p) => <Icon {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Icon>;
const IconCode2 = (p) => <Icon {...p}><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></Icon>;
const IconWrench = (p) => <Icon {...p}><path d="M14.7 6.3a4 4 0 0 0-5.5 5.3l-6.4 6.4a1 1 0 0 0 0 1.4l1.8 1.8a1 1 0 0 0 1.4 0l6.4-6.4a4 4 0 0 0 5.3-5.5l-2.6 2.6-2.5-.5-.5-2.5z"/></Icon>;
const IconBell = (p) => <Icon {...p}><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></Icon>;
const IconSettings = (p) => <Icon {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></Icon>;
const IconPanelRight = (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/></Icon>;
const IconPlus = (p) => <Icon {...p}><path d="M5 12h14"/><path d="M12 5v14"/></Icon>;
const IconChevronDown = (p) => <Icon {...p}><path d="m6 9 6 6 6-6"/></Icon>;
const IconX = (p) => <Icon {...p}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></Icon>;
const IconSearch = (p) => <Icon {...p}><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></Icon>;
const IconSparkles = (p) => <Icon {...p}><path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z"/><path d="M19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z"/><path d="M5 17l.6 1.6L7 19l-1.4.4L5 21l-.6-1.6L3 19l1.4-.4z"/></Icon>;
const IconMaximize2 = (p) => <Icon {...p}><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/></Icon>;
const IconMinimize2 = (p) => <Icon {...p}><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/></Icon>;
const IconSplitH = (p) => <Icon {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/></Icon>;
const IconCompass = (p) => <Icon {...p}><circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6z"/></Icon>;
const IconCheck = (p) => <Icon {...p}><path d="M20 6 9 17l-5-5"/></Icon>;
const IconLock = (p) => <Icon {...p}><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></Icon>;
const IconGrip = (p) => <Icon {...p}><circle cx="9" cy="6" r="1.2"/><circle cx="9" cy="12" r="1.2"/><circle cx="9" cy="18" r="1.2"/><circle cx="15" cy="6" r="1.2"/><circle cx="15" cy="12" r="1.2"/><circle cx="15" cy="18" r="1.2"/></Icon>;
const IconShield = (p) => <Icon {...p}><path d="M12 3l8 3v6c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V6z"/></Icon>;
const IconTrendingUp = (p) => <Icon {...p}><path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/></Icon>;
const IconGitBranch = (p) => <Icon {...p}><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10"/><path d="M18 9c0 4-4 4-6 4h-2"/></Icon>;
const IconNetwork = (p) => <Icon {...p}><rect x="9" y="2" width="6" height="5" rx="1"/><rect x="3" y="17" width="6" height="5" rx="1"/><rect x="15" y="17" width="6" height="5" rx="1"/><path d="M12 7v3"/><path d="M6 17v-3h12v3"/><path d="M12 10v4"/></Icon>;
const IconBookOpen = (p) => <Icon {...p}><path d="M2 4h7a3 3 0 0 1 3 3v14a2 2 0 0 0-2-2H2z"/><path d="M22 4h-7a3 3 0 0 0-3 3v14a2 2 0 0 1 2-2h8z"/></Icon>;
const IconBrain = (p) => <Icon {...p}><path d="M9.5 3a3 3 0 0 0-3 3 3 3 0 0 0-1 5.5A3 3 0 0 0 6 17a3 3 0 0 0 3 3 3 3 0 0 0 3-3V3z"/><path d="M14.5 3a3 3 0 0 1 3 3 3 3 0 0 1 1 5.5A3 3 0 0 1 18 17a3 3 0 0 1-3 3 3 3 0 0 1-3-3V3z"/></Icon>;
const IconBox = (p) => <Icon {...p}><path d="m21 16-9 5-9-5V8l9-5 9 5z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></Icon>;
const IconTerminal = (p) => <Icon {...p}><path d="m4 7 4 5-4 5"/><path d="M10 17h10"/></Icon>;
const IconBridge = (p) => <Icon {...p}><path d="M3 8c0 6 4 9 9 9s9-3 9-9"/><path d="M3 8h18"/><path d="M7 8v6"/><path d="M12 8v9"/><path d="M17 8v6"/></Icon>;

Object.assign(window, {
  Icon,
  IconLayoutGrid, IconCode2, IconWrench, IconBell, IconSettings, IconPanelRight,
  IconPlus, IconChevronDown, IconX, IconSearch, IconSparkles,
  IconMaximize2, IconMinimize2, IconSplitH, IconCompass, IconCheck, IconLock,
  IconGrip, IconShield, IconTrendingUp, IconGitBranch, IconNetwork,
  IconBookOpen, IconBrain, IconBox, IconTerminal, IconBridge,
});


/* ===== bm/data.jsx ===== */
const workspacesData = [
  { id: '1', name: 'BridgeMind Dev', dotColor: 'amber', unread: 6, alerts: 0 },
  { id: '2', name: 'Vibecademy',     dotColor: 'amber', unread: 6, alerts: 2 },
  { id: '3', name: 'Vibecademy-dev', dotColor: 'amber', unread: 4, alerts: 0 },
  { id: '4', name: 'Workspace 5',    dotColor: 'amber', unread: 0, alerts: 0 },
  { id: '5', name: 'BridgeMind',     dotColor: 'amber', unread: 6, alerts: 2 },
  { id: '6', name: 'BridgeMind',     dotColor: 'red',   unread: 6, alerts: 0 },
];

const hintExamples = [
  '> Try "how does main.rs work?"',
  '> Try "create a util logging.py that..."',
  '> Try "fix typecheck errors"',
  '> Try "fix lint errors"',
  '> Try "how do I log an error?"',
  '> Try "refactor this into smaller modules"',
];

const builtinSkillsData = [
  { name: 'BridgeSecurity', desc: 'Senior security-engineer instincts for any agent that reads, writes, or reviews code. OWASP Top 10, CWE Top 25, and supply-chain coverage.', category: 'security', icon: 'shield', builtin: true },
  { name: 'BridgeSEO',      desc: 'Modern (2025/2026) SEO methodology for auditing and writing pages — title tags, meta, headings, structured data, Core Web Vitals, and AI-search citations.', category: 'growth', icon: 'trending-up', builtin: true },
  { name: 'BridgeGithub',   desc: 'Universal commit-and-push methodology. Stages every local change in the current repo, writes a clean conventional commit, and pushes to the GitHub remote.', category: 'workflow', icon: 'git-branch', builtin: true },
  { name: 'BridgeMind MCP', desc: 'How to use the BridgeMind MCP (mcp__bridgemind__*) effectively — projects, tasks, agents, knowledge, attachments, messaging, and the strict task lifecycle.', category: 'workflow', icon: 'network', builtin: true },
  { name: 'BridgeObsidian', desc: 'Operate an Obsidian vault as an agent — vault structure, frontmatter, wikilinks, daily notes, and the three integration paths (filesystem, URI scheme, Local REST API).', category: 'workflow', icon: 'book-open', builtin: true },
  { name: 'BridgeMemory',   desc: 'Use the BridgeMemory MCP tools proactively without being asked. The builder has a hub of interconnected Markdown memories synced to BridgeSpace; recall…', category: 'memory', icon: 'brain', builtin: true },
];

const userSkillsData = [
  { name: 'Obsidian',           desc: 'How to work with Obsidian vaults. Use when reading/writing/organizing notes in an Obsidian vault — daily notes, atomic notes, wikilinks, YAML frontmatter…', category: 'knowledge', icon: 'box' },
  { name: 'BridgeVoice Deploy', desc: 'Cut a new BridgeVoice (Tauri) release. Bumps the version in package.json + src-tauri/Cargo.toml, regenerates the changelog, and publishes the GitHub release.', category: 'workflow', icon: 'box' },
  { name: 'Pomodoro Logger',    desc: 'Track focus sessions across the day. Logs start/stop, links sessions to the active task, and writes a Markdown summary to your daily note at end of day.', category: 'workflow', icon: 'box' },
  { name: 'Inbox Triage',       desc: 'Sort the inbox in three passes — archive obvious noise, surface anything that needs a reply within 24h, and snooze the rest with a follow-up suggestion.', category: 'knowledge', icon: 'box' },
];

const tagColorMap = {
  security:  { color: 'var(--tag-security)',  label: 'SECURITY' },
  growth:    { color: 'var(--tag-growth)',    label: 'GROWTH' },
  workflow:  { color: 'var(--tag-workflow)',  label: 'WORKFLOW' },
  memory:    { color: 'var(--tag-memory)',    label: 'MEMORY' },
  knowledge: { color: 'var(--tag-knowledge)', label: 'KNOWLEDGE MANAGEMENT' },
};

const skillIconMap = {
  'shield': IconShield,
  'trending-up': IconTrendingUp,
  'git-branch': IconGitBranch,
  'network': IconNetwork,
  'book-open': IconBookOpen,
  'brain': IconBrain,
  'box': IconBox,
};

Object.assign(window, {
  workspacesData, hintExamples, builtinSkillsData, userSkillsData, tagColorMap, skillIconMap,
});


/* ===== bm/TitleBar.jsx ===== */
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


/* ===== bm/WorkspaceSidebar.jsx ===== */
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


/* ===== bm/TerminalPane.jsx ===== */
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


/* ===== bm/CenterArea.jsx ===== */
function CenterArea() {
  // Rotate hint examples across all panes every 4s
  const [hintIndex, setHintIndex] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setHintIndex(i => i + 1), 4000);
    return () => clearInterval(id);
  }, []);

  // Top row running, bottom row empty
  const panes = [
    { running: true },
    { running: true },
    { running: true },
    { running: false },
    { running: false },
    { running: false },
  ];

  return (
    <main style={{
      flex: 1, minWidth: 0,
      background: 'var(--bg-base)',
      padding: 8,
      display: 'flex',
      overflow: 'hidden',
    }}>
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gridTemplateRows: 'repeat(2, minmax(0, 1fr))',
        gap: 8,
        minHeight: 0, minWidth: 0,
      }}>
        {panes.map((p, i) => (
          <TerminalPane key={i} running={p.running} paneIndex={i} hintIndex={hintIndex} />
        ))}
      </div>
    </main>
  );
}

window.CenterArea = CenterArea;


/* ===== bm/RightPanel.jsx ===== */
function SkillCard({ skill }) {
  const Icon = skillIconMap[skill.icon] || IconBox;
  const tag = tagColorMap[skill.category];
  const [hovered, setHovered] = React.useState(false);
  const [grabbing, setGrabbing] = React.useState(false);

  // Convert "var(--tag-x)" → actual hex for rgba; easier: use color directly with opacity background via inline style trick
  // We'll layer a background colored div with opacity beneath. Simpler: set bg via color-mix.
  const bgStyle = { background: `color-mix(in srgb, ${tag.color} 20%, transparent)` };

  return (
    <div
      className="skill-card"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setGrabbing(false); }}
      onMouseDown={() => setGrabbing(true)}
      onMouseUp={() => setGrabbing(false)}
      style={{
        padding: 12,
        borderRadius: 8,
        background: hovered ? 'var(--bg-elevated)' : 'transparent',
        cursor: grabbing ? 'grabbing' : (hovered ? 'grab' : 'default'),
        display: 'flex', gap: 12, alignItems: 'flex-start',
        transition: 'background 150ms ease-out',
        minHeight: 72,
      }}
    >
      <div className="grip" style={{
        flexShrink: 0, display: 'flex', alignItems: 'center',
        marginLeft: -4, color: 'var(--text-dim)', paddingTop: 6,
      }}>
        <IconGrip size={12} stroke={1.5} />
      </div>

      <div style={{
        width: 32, height: 32, flexShrink: 0,
        borderRadius: 6,
        background: hovered ? 'var(--bg-elevated-2)' : 'var(--bg-elevated)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--text-muted)',
      }}>
        <Icon size={16} />
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 14, fontWeight: 500, color: 'var(--text-primary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{skill.name}</span>
          {skill.builtin && <IconLock size={12} stroke={1.5} strokeColor="var(--text-dim)" />}
        </div>
        <div className="clamp-2" style={{
          fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45,
        }}>{skill.desc}</div>
        <div>
          <span className="tag" style={{ ...bgStyle, color: tag.color }}>{tag.label}</span>
        </div>
      </div>
    </div>
  );
}

function SmallBadge({ children, accent }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      height: 18, padding: '0 7px',
      borderRadius: 9,
      background: accent ? 'var(--accent-subtle)' : 'var(--bg-elevated)',
      color: accent ? 'var(--accent)' : 'var(--text-muted)',
      fontSize: 11, fontWeight: 500,
      lineHeight: 1,
    }}>{children}</span>
  );
}

function RightPanel() {
  const [search, setSearch] = React.useState('');
  const [focused, setFocused] = React.useState(false);

  const filter = (list) => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.desc.toLowerCase().includes(q) ||
      (tagColorMap[s.category]?.label.toLowerCase().includes(q))
    );
  };

  const builtinFiltered = filter(builtinSkillsData);
  const userFiltered = filter(userSkillsData);
  const totalCount = builtinSkillsData.length + userSkillsData.length;

  return (
    <aside style={{
      width: 380, flexShrink: 0,
      background: 'var(--bg-panel)',
      borderLeft: '1px solid var(--border-subtle)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Top tab bar */}
      <div style={{
        height: 44, flexShrink: 0,
        borderBottom: '1px solid var(--border-subtle)',
        padding: '0 12px',
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <button className="icon-btn" aria-label="Explore"><IconCompass /></button>
        <button className="icon-btn" aria-label="Snippets"><IconCode2 /></button>
        <button className="icon-btn" aria-label="Tools"><IconWrench /></button>
        <div style={{ flex: 1 }} />
        <div style={{
          position: 'relative',
          padding: '4px 10px',
          borderRadius: 6,
          background: 'var(--bg-elevated)',
          display: 'flex', flexDirection: 'column',
          minWidth: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconCheck size={12} stroke={2.25} strokeColor="var(--status-ok)" />
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>Skills</span>
          </div>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1, lineHeight: 1.2 }}>Skills — drag onto a terminal to paste</span>
          <div className="tab-underline" />
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {/* Header rows */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>Skills</span>
              <SmallBadge>{totalCount}</SmallBadge>
            </div>
            <button style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              height: 24, padding: '0 8px',
              fontSize: 12, color: 'var(--text-secondary)',
              borderRadius: 6,
              transition: 'background 150ms ease-out, color 150ms ease-out',
            }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-elevated)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-secondary)'; }}
            >
              <IconPlus size={14} />
              <span>New</span>
            </button>
          </div>

          {/* Search */}
          <div style={{
            position: 'relative',
            height: 32,
            background: 'var(--bg-input)',
            border: focused ? '1px solid var(--accent)' : '1px solid transparent',
            borderRadius: 6,
            padding: '0 10px',
            display: 'flex', alignItems: 'center', gap: 8,
            transition: 'border-color 150ms ease-out',
          }}>
            <IconSearch size={14} stroke={1.75} strokeColor="var(--text-muted)" />
            <input
              className="search-input"
              type="text"
              placeholder="Search skills"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              style={{
                flex: 1, background: 'transparent', border: 'none', outline: 'none',
                color: 'var(--text-primary)', fontSize: 13,
                fontFamily: 'inherit',
              }}
            />
            {search && (
              <button className="icon-btn-sm" aria-label="Clear" onClick={() => setSearch('')} style={{ width: 18, height: 18 }}>
                <IconX size={12} />
              </button>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Drag a skill onto a terminal to paste it. Click to preview.
          </div>
        </div>

        {/* Sections */}
        <Section title="BridgeMind" tag="Built-in" tagAccent>
          {builtinFiltered.length === 0 ? <EmptyState /> :
            builtinFiltered.map(s => <SkillCard key={s.name} skill={s} />)}
        </Section>

        <Section title="Your Skills" tag="Custom">
          {userFiltered.length === 0 ? <EmptyState /> :
            userFiltered.map(s => <SkillCard key={s.name} skill={s} />)}
        </Section>

        <div style={{ height: 16 }} />
      </div>
    </aside>
  );
}

function Section({ title, tag, tagAccent, children }) {
  return (
    <div style={{ padding: '0 8px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '6px 8px 8px',
      }}>
        <span className="section-label">{title}</span>
        {tag && (
          <span style={{
            fontSize: 10, fontWeight: 500,
            color: tagAccent ? 'var(--text-muted)' : 'var(--text-muted)',
            background: 'var(--bg-elevated)',
            padding: '2px 6px',
            borderRadius: 4,
            textTransform: 'none',
            letterSpacing: 0,
          }}>{tag}</span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{
      padding: '20px 12px',
      color: 'var(--text-dim)', fontSize: 12, textAlign: 'center',
    }}>No matching skills</div>
  );
}

window.RightPanel = RightPanel;


/* ===== bm/App.jsx ===== */
function App() {
  const [activeId, setActiveId] = React.useState('6');
  const [panelOpen, setPanelOpen] = React.useState(true);
  const active = workspacesData.find(w => w.id === activeId) || workspacesData[5];

  return (
    <div style={{
      height: '100%', width: '100%',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-base)',
      color: 'var(--text-primary)',
      overflow: 'hidden',
    }}>
      <TitleBar
        workspaceName={active.name.toLowerCase().replace(/\s+/g, '-')}
        panelOpen={panelOpen}
        onTogglePanel={() => setPanelOpen(o => !o)}
      />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <WorkspaceSidebar
          workspaces={workspacesData}
          activeId={activeId}
          onSelect={setActiveId}
        />
        <CenterArea />
        {panelOpen && <RightPanel />}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);

