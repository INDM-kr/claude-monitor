/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The live monitor moved back to "/"; keep /sessions bookmarks (query string is carried over).
  async redirects() {
    return [{ source: "/sessions", destination: "/", permanent: false }];
  },
  experimental: {
    serverComponentsExternalPackages: [
      "chokidar",
      "fsevents",
      "@claude-monitor/adapter-claude-code",
      "@claude-monitor/collector",
      "better-sqlite3",
    ],
  },
  transpilePackages: ["@claude-monitor/core"],
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Ensure chokidar's optional native dep stays a runtime require,
      // never gets bundled by webpack.
      config.externals = config.externals || [];
      // Route handlers also need the original worker URL and native addon path.
      config.externals.push("fsevents", "@claude-monitor/collector", "better-sqlite3");
    }
    return config;
  },
};

export default nextConfig;
