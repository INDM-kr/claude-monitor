import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./app/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./plugins.config.ts",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0d1117",
          soft: "#161b22",
          card: "#0f1419",
          raised: "#1c2128", // panel-2: chips, gauges, raised surfaces
        },
        border: {
          subtle: "#21262d",
          DEFAULT: "#30363d", // stronger card border
        },
        track: "#21262d", // progress-bar empty track
        // semantic session-status palette (card dots, bars, badges)
        status: {
          live: "#3fb950",
          waiting: "#d29922",
          stop: "#6e7681",
          error: "#f85149",
        },
        accent: {
          DEFAULT: "#58a6ff", // links / interactive
          purple: "#bc8cff", // permission mode
        },
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
