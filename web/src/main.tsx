import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/App';
import './index.css';

/**
 * Vite entry. Mounts the "Bank Operations Control Room" dashboard into #root.
 * Side-effecting by design: it renders <App/> and exports nothing.
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root was not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
