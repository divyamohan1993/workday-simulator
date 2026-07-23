/**
 * Tailwind CSS v3 configuration. Content globs are repo-root relative because
 * PostCSS runs from the repo root even though Vite's app root is `web/`.
 *
 * The Deutsche Bank identity (researched from db.com computed styles) lives in the
 * CSS custom properties in `web/src/index.css`; these Tailwind tokens mirror the raw
 * brand hexes for the few utilities that reference them directly, and set the type
 * to DB's own Helvetica house family (see the dmj:art-directing method).
 */
/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./web/index.html', './web/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        db: {
          navy: '#1e2a78',
          blue: '#0550d1',
          ink: '#16184e',
          slate: '#425563',
          teal: '#3bb8b8',
          magenta: '#d4005c',
          pale: '#e7f4fe',
          accent: '#0550d1',
          cyan: '#0f8a8a',
          amber: '#b7791f',
          rose: '#c8102e',
          emerald: '#0f7d33',
        },
      },
      fontFamily: {
        sans: ['Helvetica Neue', 'Helvetica', 'Arial', 'Segoe UI', 'Roboto', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'SF Mono', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
