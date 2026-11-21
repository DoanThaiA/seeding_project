import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  // Docker image uses the standalone server (NEXT_STANDALONE=1); local `next start` does not.
  ...(process.env.NEXT_STANDALONE === '1' ? { output: 'standalone' as const } : {}),
  // pnpm monorepo: trace dependencies from the repo root.
  outputFileTracingRoot: path.resolve(process.cwd(), '../..'),
  poweredByHeader: false,
  // Don't let `next dev` write AGENTS.md into the repo.
  agentRules: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default config;
