"use client";

import type { SessionSummary, WidgetSlot as Slot } from "@claude-monitor/core";
import { pluginsConfig } from "../../lib/plugins";
import { t } from "../../lib/i18n/t";

export function WidgetSlot({ slot, session }: { slot: Slot; session: SessionSummary }) {
  const widgets = pluginsConfig.widgets.filter((w) => w.slot === slot);
  if (widgets.length === 0) return null;
  return (
    <div className="space-y-1">
      {widgets.map((w) => {
        if (w.visible && !w.visible({ session, t })) return null;
        const Cmp = w.Component;
        return <Cmp key={w.id} session={session} t={t} />;
      })}
    </div>
  );
}
