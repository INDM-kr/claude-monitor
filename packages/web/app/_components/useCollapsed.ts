"use client";
import { useCallback, useEffect, useState } from "react";

export function useCollapsed(key: string): [boolean, () => void] {
  const storageKey = `cm:collapsed:${key}`;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(storageKey) === "1");
    } catch {
      /* localStorage 불가 — 기본 펼침 */
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
