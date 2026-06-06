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
