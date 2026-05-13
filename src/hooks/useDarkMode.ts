import { useState, useEffect, useCallback } from "react";

type ThemePreference = "system" | "light" | "dark";

const STORAGE_KEY = "budget-itemizer-theme";

function getStored(): ThemePreference {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {}
  return "system";
}

function applyTheme(pref: ThemePreference) {
  let dark: boolean;
  if (pref === "system") {
    dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  } else {
    dark = pref === "dark";
  }
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "");
}

export function useDarkMode() {
  const [preference, setPreference] = useState<ThemePreference>(getStored);

  const setTheme = useCallback((pref: ThemePreference) => {
    setPreference(pref);
    try { localStorage.setItem(STORAGE_KEY, pref); } catch {}
    applyTheme(pref);
  }, []);

  // Apply on mount and listen for OS changes when set to "system"
  useEffect(() => {
    applyTheme(preference);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (getStored() === "system") applyTheme("system");
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [preference]);

  return { preference, setTheme };
}
