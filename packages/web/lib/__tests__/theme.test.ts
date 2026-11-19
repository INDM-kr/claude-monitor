import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThemePreference, readThemePreference, THEME_STORAGE_KEY, themeInitScript } from "../theme";

function stubs(initial: Record<string, string> = {}, broken = false) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (k: string) => { if (broken) throw new Error("blocked"); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (broken) throw new Error("blocked"); store.set(k, v); },
    removeItem: (k: string) => { if (broken) throw new Error("blocked"); store.delete(k); },
  };
  const root = { dataset: {} as Record<string, string> };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("document", { documentElement: root });
  return { store, root, storage };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("theme preference", () => {
  it("pins dark/light on <html> and returns to OS mode on system", () => {
    const { store, root } = stubs();
    applyThemePreference("dark");
    expect(root.dataset.theme).toBe("dark"); expect(store.get(THEME_STORAGE_KEY)).toBe("dark");
    expect(readThemePreference()).toBe("dark");
    applyThemePreference("system");
    expect(root.dataset.theme).toBeUndefined(); expect(store.has(THEME_STORAGE_KEY)).toBe(false);
    expect(readThemePreference()).toBe("system");
  });

  it("ignores unknown stored values and blocked storage", () => {
    stubs({ [THEME_STORAGE_KEY]: "sepia" });
    expect(readThemePreference()).toBe("system");
    const { root } = stubs({}, true);
    expect(readThemePreference()).toBe("system");
    expect(() => applyThemePreference("light")).not.toThrow();
    expect(root.dataset.theme).toBe("light");
  });

  it("init script applies only a valid stored mode before paint and never throws", () => {
    const run = (initial: Record<string, string>, broken = false) => {
      const { root, storage } = stubs(initial, broken);
      new Function("localStorage", "document", themeInitScript)(storage, { documentElement: root });
      return root.dataset.theme;
    };
    expect(run({ [THEME_STORAGE_KEY]: "light" })).toBe("light");
    expect(run({ [THEME_STORAGE_KEY]: "<script>" })).toBeUndefined();
    expect(run({}, true)).toBeUndefined();
  });
});
