import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api/yahoo': {
        target: 'https://query1.finance.yahoo.com/v8/finance/chart',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/yahoo\//, ''),
      },
    },
  },
});