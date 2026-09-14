/** Compact token/count formatting (e.g. 82600000 → "82.6M", 3400 → "3k"). */
export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/** Epoch seconds → localized short date (e.g. "2026. 06. 23."). */
export function fmtDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
