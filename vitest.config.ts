import { defineConfig } from 'vitest/config';
import path from 'path';

// Lightweight inline plugin that transforms .tsx files with esbuild
// before Vite's import-analysis parser runs. This avoids the need for
// @vitejs/plugin-react (which introduces esbuild peer dep conflicts).
function esbuildJsx() {
  return {
    name: 'esbuild-jsx',
    enforce: 'pre',
    async transform(code: string, id: string) {
      if (!id.endsWith('.tsx') && !id.endsWith('.jsx')) return null;
      const { transform } = await import('esbuild');
      const result = await transform(code, {
        loader: id.endsWith('.tsx') ? 'tsx' : 'jsx',
        jsx: 'automatic',
        sourcefile: id,
      });
      return { code: result.code, map: result.map || null };
    },
  };
}

export default defineConfig({
  plugins: [esbuildJsx()],
  test: {
    globals: true,
    environment: 'node',
    exclude: [
      '**/node_modules/**',
      '**/e2e/**',
      '**/__shortest__/**',
      '**/admin/__shortest__/**',
      '**/admin/src/__tests__/**',
      '**/.claude/worktrees/**',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: [
        'node_modules/**',
        'admin/**',
        'e2e/**',
        '**/__shortest__/**',
        '**/*.config.*',
        '**/*.d.ts',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
