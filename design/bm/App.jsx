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
