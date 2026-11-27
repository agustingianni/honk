import { createContext, useContext } from "react";
import { builtinThemes, DEFAULT_THEME_ID, type Theme } from "./themes/index.ts";

// The colors in use. Components read this object directly. applyTheme copies
// another theme's colors into it, so the object itself never changes, and a
// re-render shows the new colors.
export const theme: Theme = {
  ...builtinThemes().find((t) => t.id === DEFAULT_THEME_ID)!.theme,
};

export function applyTheme(next: Theme): void {
  Object.assign(theme, next);
}

/**
 * Goes up by one each time App applies a theme, or when the renderer starts to
 * measure text cells another way (see `setWidthMethod`). A component that skips
 * re-renders (memo) or caches colors (useMemo) reads it, so it renders again
 * with the new colors and cuts its text again. Other components re-render with
 * App anyway.
 */
export const ThemeVersion = createContext(0);

export function useThemeVersion(): number {
  return useContext(ThemeVersion);
}

export function nickColor(nick: string): string {
  let hash = 2166136261;
  const lower = nick.toLowerCase();
  for (let i = 0; i < lower.length; i++) {
    hash ^= lower.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return theme.nickPalette[Math.abs(hash) % theme.nickPalette.length]!;
}

export function prefixColor(prefix: string): string {
  switch (prefix) {
    case "~":
    case "&":
      return theme.red;
    case "@":
      return theme.yellow;
    case "%":
      return theme.orange;
    case "+":
      return theme.green;
    default:
      return theme.fgMuted;
  }
}
