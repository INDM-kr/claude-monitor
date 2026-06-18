"use client";

import clsx from "clsx";
import type { AgentGroup } from "../../lib/group";
import { useCollapsed } from "./useCollapsed";
import { AgentRow } from "./AgentRow";

/** A workflow run (wf_*) as a collapsible group: header with done/total, then
 *  its agent rows indented underneath. */
export function WorkflowGroup({
  group,
  trunk,
}: {
  group: AgentGroup;
  trunk?: { live: boolean } | null;
}) {
  const wf = group.wfId ?? "";
  const [collapsed, toggle] = useCollapsed(`wf:${wf}`);
  const allDone = group.done === group.total;
  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-baseline whitespace-nowrap px-2 leading-[1.3] text-left hover:bg-bg-soft/40"
      >
        <span className="whitespace-pre">
          {trunk ? (
            <span className={trunk.live ? "text-emerald-600" : "text-zinc-700"}>│</span>
          ) : (
            " "
          )}
          {"  "}
        </span>
        <span className="inline-block w-[1ch] shrink-0 text-zinc-500">{collapsed ? "▸" : "▾"}</span>
        <span className="ml-1 shrink-0 text-violet-300">🔀 {wf.replace(/^wf_/, "")}</span>
        <span className={clsx("ml-2 shrink-0 text-[10px]", allDone ? "text-emerald-400" : "text-zinc-500")}>
          {group.done}/{group.total}
        </span>
      </button>
      {!collapsed &&
        group.agents.map((a) => (
          <AgentRow
            key={`${a.ref.adapterId}::${a.ref.id}`}
            agent={a}
            trunk={trunk}
            indent={3}
          />
        ))}
    </div>
  );
}
