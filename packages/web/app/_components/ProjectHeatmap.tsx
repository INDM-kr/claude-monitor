import clsx from "clsx";

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}
function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// 0 = none, 1-4 = increasing intensity (GitHub-style emerald scale on a dark bg).
const LEVELS = ["bg-zinc-800/60", "bg-emerald-900", "bg-emerald-700", "bg-emerald-500", "bg-emerald-400"];
function levelOf(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((v / max) * 4)));
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const HEATMAP_DAYS = 182; // ~26 weeks

/** GitHub-contributions-style token activity: a week-column grid over the last ~6
 *  months, plus a weekday×hour grid showing when work happens. Pure render. */
export function ProjectHeatmap({
  daily,
  weekdayHour,
}: {
  daily: Record<string, number>;
  weekdayHour: number[][];
}) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - HEATMAP_DAYS);
  start.setDate(start.getDate() - start.getDay()); // back up to Sunday

  const dailyMax = Math.max(1, ...Object.values(daily));
  const weeks: { key: string; tokens: number; future: boolean }[][] = [];
  const cur = new Date(start);
  while (cur <= today) {
    const week: { key: string; tokens: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const key = dateKey(cur);
      week.push({ key, tokens: daily[key] ?? 0, future: cur > today });
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(week);
  }

  const whMax = Math.max(1, ...weekdayHour.flat());

  return (
    <div className="space-y-5">
      {/* contribution grid */}
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((cell) =>
              cell.future ? (
                <span key={cell.key} className="h-2.5 w-2.5" />
              ) : (
                <span
                  key={cell.key}
                  title={`${cell.key} · ${fmtCount(cell.tokens)} 토큰`}
                  className={clsx("h-2.5 w-2.5 rounded-sm", LEVELS[levelOf(cell.tokens, dailyMax)])}
                />
              ),
            )}
          </div>
        ))}
      </div>

      {/* weekday × hour pattern */}
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-[10px] text-zinc-600">
          <span className="w-6" />
          {[0, 6, 12, 18, 23].map((h) => (
            <span key={h} className="tabular-nums" style={{ marginLeft: h === 0 ? 0 : "auto" }}>
              {String(h).padStart(2, "0")}시
            </span>
          ))}
        </div>
        {weekdayHour.map((row, wd) => (
          <div key={wd} className="flex items-center gap-[3px]">
            <span className="w-6 text-[10px] text-zinc-500">{WEEKDAYS[wd]}</span>
            {row.map((v, h) => (
              <span
                key={h}
                title={`${WEEKDAYS[wd]} ${String(h).padStart(2, "0")}시 · ${fmtCount(v)} 토큰`}
                className={clsx("h-2.5 flex-1 rounded-[2px]", LEVELS[levelOf(v, whMax)])}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
