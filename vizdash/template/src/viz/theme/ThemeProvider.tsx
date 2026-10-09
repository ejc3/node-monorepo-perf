"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Mode = "light" | "dark";
const ThemeContext = createContext<{ mode: Mode; toggle: () => void }>({
  mode: "light",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<Mode>("light");
  useEffect(() => {
    const saved = window.localStorage.getItem("vizdash-theme");
    if (saved === "dark" || saved === "light") setMode(saved);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);
  const toggle = useCallback(() => {
    setMode((m) => {
      const next = m === "light" ? "dark" : "light";
      window.localStorage.setItem("vizdash-theme", next);
      return next;
    });
  }, []);
  const value = useMemo(() => ({ mode, toggle }), [mode, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

export function ThemeToggle() {
  const { mode, toggle } = useTheme();
  return (
    <button className="icon-button" onClick={toggle} aria-label="Toggle color theme">
      {mode === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}
