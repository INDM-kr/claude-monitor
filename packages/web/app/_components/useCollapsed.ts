"use client";
import { useCallback, useEffect, useState } from "react";

export function useCollapsed(key: string, defaultCollapsed = false): [boolean, () => void] {
  const storageKey = `cm:collapsed:${key}`;
  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  useEffect(() => {
    try {
      // 저장값이 있을 때만 덮어쓴다. 없으면 defaultCollapsed 유지 — 한 번도
      // 토글 안 한 카드/그룹은 기본 상태를 따라가게.
      const v = localStorage.getItem(storageKey);
      if (v !== null) setCollapsed(v === "1");
    } catch {
      /* localStorage 불가 — 기본값 유지 */
    }
  }, [storageKey]);

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [storageKey]);

  return [collapsed, toggle];
}
