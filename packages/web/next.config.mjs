/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      "chokidar",
      "fsevents",
      "@claude-monitor/adapter-claude-code",
    ],
  },
  transpilePackages: ["@claude-monitor/core"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Ensure chokidar's optional native dep stays a runtime require,
      // never gets bundled by webpack.
      config.externals = config.externals || [];
      config.externals.push("fsevents");
    }
    return config;
  },
};

export default nextConfig;
