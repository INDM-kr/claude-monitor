import type { UsagePoint } from "@claude-monitor/adapter-claude-code";
import { t } from "../../lib/i18n/t";

export function UsageTrend({ points }: { points: UsagePoint[] }) {
  if (points.length < 2) return <div className="text-xs text-zinc-600">{t("detail.noUsage")}</div>;
  const w = 480;
  const h = 80;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.tokens);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys, 1);
  const sx = (x: number) => (maxX === minX ? 0 : ((x - minX) / (maxX - minX)) * w);
  const sy = (y: number) => h - (y / maxY) * h;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.ts).toFixed(1)},${sy(p.tokens).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full max-w-lg h-20">
      <path d={d} fill="none" stroke="#34d399" strokeWidth={1.5} />
    </svg>
  );
}
