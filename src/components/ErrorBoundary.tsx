import React from 'react'
import { translate } from '../i18n'
import { useWorkspaceStore } from '../store/workspace'

interface Props {
  children: React.ReactNode
  label?: string
}

interface State {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(err: Error): State {
    return { hasError: true, message: err.message }
  }

  render() {
    if (!this.state.hasError) return this.props.children
    const lang = useWorkspaceStore.getState().language
    const label = this.props.label ?? translate(lang, 'error.component')
    return (
      <div style={styles.container}>
        <p style={styles.title}>⚠ {translate(lang, 'error.crashed', { label })}</p>
        <pre style={styles.msg}>{this.state.message}</pre>
        <button
          style={styles.btn}
          onClick={() => this.setState({ hasError: false, message: '' })}
        >
          {translate(lang, 'common.retry')}
        </button>
      </div>
    )
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    gap: 10,
    padding: 16,
    color: 'var(--error)'
  },
  title: { fontSize: 13, fontWeight: 600 },
  msg: {
    fontSize: 10,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    maxWidth: 400,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    textAlign: 'center'
  },
  btn: {
    background: 'var(--bg-active)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-primary)',
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 12
  }
}
