/**
 * Tailwind CSS v3 configuration. Content globs are repo-root relative because
 * PostCSS runs from the repo root even though Vite's app root is `web/`.
 *
 * A starter Deutsche Bank inspired palette is provided; the web builder refines the
 * full visual identity (see the dmj:art-directing method).
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        db: {
          blue: '#0018A8',
          ink: '#0A0E27',
          slate: '#111528',
          accent: '#3B82F6',
          cyan: '#22D3EE',
          amber: '#F59E0B',
          rose: '#F43F5E',
          emerald: '#10B981',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
