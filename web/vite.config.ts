import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), tailwindcss()],
  // Only web/public is served statically. The project root (and the restricted source folder) is never exposed.
  publicDir: path.resolve(__dirname, 'public'),
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    fs: { strict: true, allow: [path.resolve(__dirname), path.resolve(__dirname, '../shared'), path.resolve(__dirname, '../node_modules')], deny: ['**/DONE/**', '.env', '.env.*'] },
    watch: { ignored: ['**/DONE/**', '**/.venv/**'] },
    proxy: { '/api': 'http://127.0.0.1:4000' },
  },
  build: { outDir: path.resolve(__dirname, '../dist/web'), emptyOutDir: true, chunkSizeWarningLimit: 1500, sourcemap: false },
});
