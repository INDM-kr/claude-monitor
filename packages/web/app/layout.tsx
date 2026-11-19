import "./theme.css";
import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { themeInitScript } from "../lib/theme";

export const metadata: Metadata = {
  title: "Claude Monitor · 로컬 작업 모니터",
  description: "프로젝트별 AI 사용량, 실행 상태와 작업 결과를 확인하는 로컬 모니터",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The inline script may set data-theme before hydration.
    <html lang="ko" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="font-sans bg-bg text-zinc-200 min-h-screen">{children}</body>
    </html>
  );
}
