/** Compact token/count formatting (e.g. 82600000 → "82.6M", 3400 → "3k"). */
export function fmtCount(n: number): string {
  const k = Math.round(n / 1e3);
  // 999,500+ would round to "1000k" — show it as "1.0M" instead.
  if (n >= 1e6 || k >= 1000) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${k}k`;
  return String(n);
}

// Built once: the dashboard re-renders every second and formats a date per
// project header. Same output as toLocaleDateString with these options.
const DATE_FMT = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit" });

/** Epoch seconds → localized short date (e.g. "2026. 06. 23."). */
export function fmtDate(sec: number): string {
  return DATE_FMT.format(new Date(sec * 1000));
}
