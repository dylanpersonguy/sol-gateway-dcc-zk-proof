import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [
    react(),
  ],
  server: {
    port: 3333,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  define: {
    'global': 'globalThis',
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          solana: ['@solana/web3.js'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
