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
