import type { TodoSnapshot } from "@claude-monitor/core";
import { truncate } from "@claude-monitor/core";
import { t } from "../../lib/i18n/t";

export function TodoProgress({ todo }: { todo: TodoSnapshot }) {
  const pct = todo.total === 0 ? 0 : Math.round((todo.done / todo.total) * 100);
  return (
    <div className="text-xs space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-emerald-400 font-semibold">
          {t("card.todo")} {todo.done}/{todo.total}
        </span>
        <div className="h-1 flex-1 bg-zinc-800 rounded overflow-hidden">
          <div
            className="h-full bg-emerald-500/70"
            style={{ width: `${pct}%` }}
            aria-label={`${pct}%`}
          />
        </div>
      </div>
      {todo.current && (
        <div className="text-emerald-300/90 pl-2">
          ▶ {t("card.todoCurrent")}: {truncate(todo.current, 80)}
        </div>
      )}
      {todo.next && (
        <div className="text-zinc-400 pl-2">· {t("card.todoNext")}: {truncate(todo.next, 80)}</div>
      )}
    </div>
  );
}
