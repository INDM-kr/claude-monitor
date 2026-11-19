/** Viewer theme preference. "system" follows the OS color scheme; the others pin a mode. */
export type ThemePreference = "system" | "dark" | "light";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "dark", "light"];
export const THEME_STORAGE_KEY = "cm-theme";

/** Inlined in <head>: applies a stored pinned mode before first paint so it never flashes. */
export const themeInitScript = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="dark"||t==="light")document.documentElement.dataset.theme=t}catch(e){}`;

export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "dark" || stored === "light" ? stored : "system";
  } catch {
    return "system";
  }
}

/** Storage can be unavailable (private window); the mode still applies for this page. */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") delete root.dataset.theme;
  else root.dataset.theme = preference;
  try {
    if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* per-viewer convenience only */
  }
}
