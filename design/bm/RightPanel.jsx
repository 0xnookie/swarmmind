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
