import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

const LOGICAL_ENVIRONMENTS = new Set(['production', 'staging', 'development']);

function normalizeLogicalEnvironment(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return LOGICAL_ENVIRONMENTS.has(normalized) ? normalized : 'unverified';
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const logicalEnvironment = normalizeLogicalEnvironment(
    process.env.WAAIIO_ENVIRONMENT
      || process.env.VITE_WAAIIO_ENVIRONMENT
      || env.WAAIIO_ENVIRONMENT
      || env.VITE_WAAIIO_ENVIRONMENT,
  );

  const buildIdentity = {
    logicalEnvironment,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '',
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || '',
    projectId: process.env.VERCEL_PROJECT_ID || '',
    vercelTarget: process.env.VERCEL_TARGET_ENV || process.env.VERCEL_ENV || '',
    apiUrl: process.env.VITE_API_URL || env.VITE_API_URL || '',
  };

  return {
    base: '/',
    plugins: [react()],
    define: {
      __WAAIIO_ADMIN_BUILD_IDENTITY__: JSON.stringify(buildIdentity),
      'process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY': JSON.stringify(
        process.env.VITE_GOOGLE_MAPS_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY
          || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '',
      ),
      'process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY': JSON.stringify(
        process.env.VITE_GOOGLE_PLACES_API_KEY || env.VITE_GOOGLE_PLACES_API_KEY
          || process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY || env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY || '',
      ),
    },
    server: {
      port: 8083,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, '../shared'),
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/__tests__/setup.ts'],
      exclude: ['**/node_modules/**', '**/__shortest__/**'],
    },
  };
});
