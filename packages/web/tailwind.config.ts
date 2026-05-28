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
        },
        border: {
          subtle: "#21262d",
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
