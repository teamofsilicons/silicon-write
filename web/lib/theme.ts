/** Shared theme preference: applied before first paint, persisted locally, and synced across tabs. */
import { appConfig } from "@/lib/app.config";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";
export const THEME_STORAGE_KEY = `${appConfig.appId}.theme`;
const THEME_EVENT = "write:theme";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";
const preference = (value: string | null): ThemePreference => value === "light" || value === "dark" ? value : "system";

export const THEME_BOOT_SCRIPT = `(function(){var r=document.documentElement,p="system";r.setAttribute("data-js","");try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==="light"||s==="dark")p=s}catch(e){}var t=p==="system"?(matchMedia("${SYSTEM_QUERY}").matches?"dark":"light"):p;r.setAttribute("data-theme",t);r.setAttribute("data-theme-preference",p);r.style.colorScheme=t;})();`;

export const resolveTheme = (value: ThemePreference): Theme => value === "system"
  ? typeof window !== "undefined" && window.matchMedia(SYSTEM_QUERY).matches ? "dark" : "light"
  : value;
export const currentTheme = (): Theme => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
export const themePreference = (): ThemePreference => typeof document === "undefined" ? "system" : preference(document.documentElement.getAttribute("data-theme-preference"));

export function applyTheme(value: Theme, pref: ThemePreference) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = value;
  root.dataset.themePreference = pref;
  root.style.colorScheme = value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", value === "dark" ? "#141414" : "#FFFFFF");
}

export function setThemePreference(value: ThemePreference) {
  applyTheme(resolveTheme(value), value);
  try { localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* The choice still works when storage is blocked. */ }
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function subscribeTheme(listener: () => void): () => void {
  const media = window.matchMedia(SYSTEM_QUERY);
  const systemChanged = () => {
    if (themePreference() === "system") { applyTheme(resolveTheme("system"), "system"); listener(); }
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    const next = preference(event.newValue);
    applyTheme(resolveTheme(next), next);
    listener();
  };
  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener("storage", storageChanged);
  media.addEventListener("change", systemChanged);
  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener("storage", storageChanged);
    media.removeEventListener("change", systemChanged);
  };
}

export const changeTheme = (next: ThemePreference) => setThemePreference(next);
