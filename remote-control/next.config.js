/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow fetching from main homestead server
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3005/api/:path*',
      },
    ];
  },
};

module.exports = nextConfig;
