import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: true,
  },
  /**
   * The presenter IS the app (Josh 2026-09-03: "it'd be nice if we could just
   * point at the root"). Serve it AT '/' instead of redirecting there, so
   * localhost:3005 is the real front door — no hop, no query string, no
   * '/presenter/index.html' in the address bar.
   *
   * A rewrite (not a redirect) means the URL stays '/' while the static file
   * under public/presenter/ is what gets served. '/presenter/index.html' keeps
   * working unchanged, so the APK and Electron shell need no rebuild.
   */
  async rewrites() {
    return [
      { source: '/', destination: '/presenter/index.html' },
      { source: '/presenter', destination: '/presenter/index.html' },
      { source: '/presenter/', destination: '/presenter/index.html' },
    ];
  },
};

export default nextConfig;
