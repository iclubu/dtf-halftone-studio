import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Builds to ONE self-contained dist/index.html (all JS/CSS inlined).
// Double-click to open — no `npm run dev`, no server needed. Runs fully offline;
// the only network use is the optional external background remover, opened in a pop-up.
export default defineConfig({
  plugins: [viteSingleFile()],
});
