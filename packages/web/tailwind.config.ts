import type { Config } from "tailwindcss";

// Every color resolves to a CSS token from app/theme.css, so the same classes render the
// light and dark modes. Palette families listed here override only the shades in use.
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
    "./plugins.config.ts",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "rgb(var(--c-bg) / <alpha-value>)",
          soft: "rgb(var(--c-bg-soft) / <alpha-value>)",
          card: "rgb(var(--c-bg-card) / <alpha-value>)",
          raised: "rgb(var(--c-bg-raised) / <alpha-value>)",
          elevated: "rgb(var(--c-bg-elevated) / <alpha-value>)",
        },
        border: {
          DEFAULT: "rgb(var(--c-border) / <alpha-value>)",
          subtle: "rgb(var(--c-border-subtle) / <alpha-value>)",
          strong: "rgb(var(--c-border-strong) / <alpha-value>)",
        },
        track: "rgb(var(--c-track) / <alpha-value>)",
        ink: "rgb(var(--c-ink) / <alpha-value>)",
        muted: "rgb(var(--c-muted) / <alpha-value>)",
        faint: "rgb(var(--c-faint) / <alpha-value>)",
        status: {
          live: "rgb(var(--c-status-live) / <alpha-value>)",
          waiting: "rgb(var(--c-status-waiting) / <alpha-value>)",
          stop: "rgb(var(--c-status-stop) / <alpha-value>)",
          error: "rgb(var(--c-status-error) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "rgb(var(--c-accent) / <alpha-value>)",
          strong: "rgb(var(--c-accent-strong) / <alpha-value>)",
          soft: "rgb(var(--c-accent-soft) / <alpha-value>)",
          muted: "rgb(var(--c-accent-muted) / <alpha-value>)",
          purple: "rgb(var(--c-accent-purple) / <alpha-value>)",
        },
        zinc: {
          "50": "rgb(var(--c-zinc-50) / <alpha-value>)",
          "100": "rgb(var(--c-zinc-100) / <alpha-value>)",
          "200": "rgb(var(--c-zinc-200) / <alpha-value>)",
          "300": "rgb(var(--c-zinc-300) / <alpha-value>)",
          "400": "rgb(var(--c-zinc-400) / <alpha-value>)",
          "500": "rgb(var(--c-zinc-500) / <alpha-value>)",
          "600": "rgb(var(--c-zinc-600) / <alpha-value>)",
          "700": "rgb(var(--c-zinc-700) / <alpha-value>)",
          "800": "rgb(var(--c-zinc-800) / <alpha-value>)",
          "900": "rgb(var(--c-zinc-900) / <alpha-value>)",
          "950": "rgb(var(--c-zinc-950) / <alpha-value>)",
        },
        emerald: {
          "200": "rgb(var(--c-emerald-200) / <alpha-value>)",
          "300": "rgb(var(--c-emerald-300) / <alpha-value>)",
          "400": "rgb(var(--c-emerald-400) / <alpha-value>)",
          "500": "rgb(var(--c-emerald-500) / <alpha-value>)",
          "600": "rgb(var(--c-emerald-600) / <alpha-value>)",
          "700": "rgb(var(--c-emerald-700) / <alpha-value>)",
          "900": "rgb(var(--c-emerald-900) / <alpha-value>)",
        },
        cyan: {
          "200": "rgb(var(--c-cyan-200) / <alpha-value>)",
          "300": "rgb(var(--c-cyan-300) / <alpha-value>)",
          "400": "rgb(var(--c-cyan-400) / <alpha-value>)",
          "500": "rgb(var(--c-cyan-500) / <alpha-value>)",
        },
        amber: {
          "300": "rgb(var(--c-amber-300) / <alpha-value>)",
          "500": "rgb(var(--c-amber-500) / <alpha-value>)",
        },
        red: {
          "300": "rgb(var(--c-red-300) / <alpha-value>)",
          "400": "rgb(var(--c-red-400) / <alpha-value>)",
          "500": "rgb(var(--c-red-500) / <alpha-value>)",
        },
        violet: {
          "300": "rgb(var(--c-violet-300) / <alpha-value>)",
          "500": "rgb(var(--c-violet-500) / <alpha-value>)",
        },
        sky: {
          "300": "rgb(var(--c-sky-300) / <alpha-value>)",
          "500": "rgb(var(--c-sky-500) / <alpha-value>)",
        },
        rose: {
          "300": "rgb(var(--c-rose-300) / <alpha-value>)",
          "500": "rgb(var(--c-rose-500) / <alpha-value>)",
        },
        fuchsia: {
          "300": "rgb(var(--c-fuchsia-300) / <alpha-value>)",
          "500": "rgb(var(--c-fuchsia-500) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};

export default config;
