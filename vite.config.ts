import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: { exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${process.env.SELFTRAIN_PORT ?? 8787}`,
    },
  },
});
