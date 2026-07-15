import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      core: path.resolve(__dirname, '../core/src'),
      ui: path.resolve(__dirname, '../ui/src'),
    },
  },
  server: {
    host: true,
    port: 5174,
  },
});
