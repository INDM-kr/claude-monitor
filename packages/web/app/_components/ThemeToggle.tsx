"use client";
import { useEffect, useState } from "react";
import { applyThemePreference, readThemePreference, THEME_PREFERENCES, type ThemePreference } from "../../lib/theme";

const LABELS: Record<ThemePreference, string> = { system: "자동", dark: "다크", light: "라이트" };

export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>("system");
  useEffect(() => setPreference(readThemePreference()), []);
  const choose = (next: ThemePreference) => {
    applyThemePreference(next);
    setPreference(next);
  };
  return (
    <div className="local-theme" role="group" aria-label="화면 모드">
      {THEME_PREFERENCES.map((option) => (
        <button key={option} type="button" aria-pressed={preference === option} onClick={() => choose(option)}>
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
