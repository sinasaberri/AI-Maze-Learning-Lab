import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource/ibm-plex-mono/latin-400.css'
import './style.css'
import App from './App'

const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)
