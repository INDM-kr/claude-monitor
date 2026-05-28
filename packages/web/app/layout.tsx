import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Claude Code 세션 모니터",
  description: "Real-time monitor for Claude Code sessions",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko" className="dark">
      <body className="font-mono bg-bg text-zinc-200 min-h-screen">{children}</body>
    </html>
  );
}
