import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';

/**
 * Minimal mount stub. The web builder REPLACES this file with the real dashboard
 * (live telemetry over /ws/telemetry, scenario and target management over /api).
 * It renders a coherent placeholder so `pnpm dev:web` shows an intentional page
 * rather than a blank canvas while the app is being built.
 */
function ScaffoldReady(): React.JSX.Element {
  return (
    <main
      style={{
        minHeight: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: '2rem',
        textAlign: 'center',
      }}
    >
      <div style={{ maxWidth: '42rem' }}>
        <p
          style={{
            letterSpacing: '0.35em',
            fontSize: '0.75rem',
            textTransform: 'uppercase',
            color: '#22D3EE',
            marginBottom: '1rem',
          }}
        >
          Deutsche Bank
        </p>
        <h1 style={{ fontSize: '2.5rem', fontWeight: 800, lineHeight: 1.1, margin: 0 }}>
          Workday Simulator
        </h1>
        <p style={{ marginTop: '1rem', color: '#9CA3AF', fontSize: '1.05rem' }}>
          Scaffold ready. The cinematic dashboard mounts here, streaming a live
          Deutsche Bank workday to the Identity Manager under test.
        </p>
      </div>
    </main>
  );
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root was not found in index.html');
}

createRoot(container).render(
  <StrictMode>
    <ScaffoldReady />
  </StrictMode>,
);
