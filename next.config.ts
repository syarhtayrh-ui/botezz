import type {NextConfig} from 'next';

const createNextConfig = (phase: string): NextConfig => ({
  reactStrictMode: true,
  distDir: phase === 'phase-development-server' ? '.next-dev' : '.next',
  devIndicators: false,
  experimental: {
    devtoolSegmentExplorer: false,
  },
  serverExternalPackages: ['@hiroosy/baileys-lite', 'werift', 'pino', 'grammy'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  webpack: (config, {dev}) => {
    if (dev) {
      config.cache = false;
    }
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify—file watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
});

export default createNextConfig;

