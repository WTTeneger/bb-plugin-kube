// Two-language UI: every visible string is written as L("English", "Русский").
// The language comes from the plugin's "language" setting (see server.ts),
// delivered with the config RPC; components re-render when config changes.
export type Lang = "en" | "ru";

const STORAGE_KEY = "bb-kube.lang";

// Start from the last language this browser saw, so a Russian UI does not
// flash English while the config request is in flight.
let current: Lang = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) === "ru" ? "ru" : "en";
  } catch {
    return "en";
  }
})();

export function setLang(lang: Lang | undefined | null) {
  current = lang === "ru" ? "ru" : "en";
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    /* storage unavailable */
  }
}

export function getLang(): Lang {
  return current;
}

/** Pick the string (or node) for the active language. */
export function L<T>(en: T, ru: T): T {
  return current === "ru" ? ru : en;
}
