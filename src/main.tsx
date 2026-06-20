import './process-shim'  // must run before @xenova/transformers is ever loaded
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SwarmAgentWidget } from './components/SwarmAgentWidget'
import './assets/global.css'

// The same renderer bundle serves two windows: the full app and the small
// SwarmAgent desktop widget. The widget window loads this page with a `#widget`
// hash (see electron/main.ts::createWidgetWindow), so we mount the compact
// widget instead of the whole app — none of App's heavy side effects (PTYs,
// conductor, loops) run in the widget window.
const isWidget = window.location.hash === '#widget'

if (isWidget) document.documentElement.classList.add('widget')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isWidget ? <SwarmAgentWidget /> : <App />}
  </React.StrictMode>
)
