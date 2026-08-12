import { useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

const QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ThemeMode {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia(QUERY).matches ? "dark" : "light";
}

/**
 * Follows the operating system's light/dark preference.
 *
 * The stylesheet already reacts through `prefers-color-scheme`, but the
 * attribute is what Monaco, xterm, and the branding mark read — none of those
 * are CSS, so they cannot pick the palette up on their own.
 */
export function useSystemTheme(): ThemeMode {
  const [theme, setTheme] = useState<ThemeMode>(systemTheme);

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const apply = () => setTheme(media.matches ? "dark" : "light");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return theme;
}

/** Editor and terminal colours, kept beside the CSS tokens they mirror. */
export const EDITOR_THEME = {
  dark: {
    base: "vs-dark" as const,
    rules: [
      { token: "comment", foreground: "707080", fontStyle: "italic" },
      { token: "keyword", foreground: "c38cff" },
      { token: "string", foreground: "9ad7b0" },
      { token: "number", foreground: "efb177" },
      { token: "type.identifier", foreground: "75c8cf" },
    ],
    colors: {
      "editor.background": "#121116",
      "editor.foreground": "#dad8e1",
      "editorLineNumber.foreground": "#4d4b58",
      "editorLineNumber.activeForeground": "#a6a2af",
      "editorCursor.foreground": "#b47aff",
      "editor.selectionBackground": "#7042a04d",
      "editor.lineHighlightBackground": "#18171e",
      "editorIndentGuide.background1": "#24222c",
      "editorIndentGuide.activeBackground1": "#484352",
      "editorGutter.background": "#121116",
    },
  },
  light: {
    base: "vs" as const,
    rules: [
      { token: "comment", foreground: "8a8595", fontStyle: "italic" },
      { token: "keyword", foreground: "8923d9" },
      { token: "string", foreground: "1f7a4d" },
      { token: "number", foreground: "a2560f" },
      { token: "type.identifier", foreground: "14707a" },
    ],
    colors: {
      "editor.background": "#f2f1f4",
      "editor.foreground": "#28242e",
      "editorLineNumber.foreground": "#a5a1a9",
      "editorLineNumber.activeForeground": "#4d4952",
      "editorCursor.foreground": "#8923d9",
      "editor.selectionBackground": "#c9a8ec80",
      "editor.lineHighlightBackground": "#e9e8ec",
      "editorIndentGuide.background1": "#dfdee2",
      "editorIndentGuide.activeBackground1": "#b9b5bf",
      "editorGutter.background": "#f2f1f4",
    },
  },
};

export const TERMINAL_THEME = {
  dark: { background: "#121116", foreground: "#dad8e1", cursor: "#b47aff" },
  light: { background: "#f2f1f4", foreground: "#28242e", cursor: "#8923d9" },
};
