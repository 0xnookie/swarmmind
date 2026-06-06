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
