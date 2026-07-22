/**
 * PostCSS pipeline for the dashboard: Tailwind v3 then Autoprefixer. Kept at the
 * repo root so Vite (app root `web/`) resolves it by walking up from the app root.
 */
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
