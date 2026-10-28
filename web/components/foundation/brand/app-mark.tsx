/**
 * The supplied feather, in theme-aware ink beside the name, like DM's standalone navigation mark.
 * App icons and link previews retain the original dark tile (lib/brand-svg.ts).
 * Plain SVG, server-rendered, shared by the landing page, the sign-in page and the signed-in shell.
 *
 *   <AppMark />                 the bare glyph at 22 px
 *   <AppMark size={40} />       larger
 *   <Wordmark />                the glyph and the app's name
 */
import type { CSSProperties } from "react";
import { appConfig } from "@/lib/app.config";
import styles from "./app-mark.module.css";

export function AppGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox={appConfig.mark.viewBox} width={size} height={size} fill="none" stroke="currentColor" strokeWidth={appConfig.mark.strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {appConfig.mark.paths.map(d => <path key={d} d={d} />)}
    </svg>
  );
}

export function AppMark({ size = 22, className }: { size?: number; className?: string }) {
  const style = { "--mark-size": `${size}px` } as CSSProperties;
  return (
    <span className={[styles.mark, className].filter(Boolean).join(" ")} style={style} aria-hidden="true">
      <AppGlyph size={size} />
    </span>
  );
}

/** The wordmark's words ("Silicon Remind"): a link that shows the wordmark is named with them first (WCAG 2.5.3). */
export const BRAND_NAME = appConfig.brandPrefix ? `${appConfig.brandPrefix} ${appConfig.name}` : appConfig.name;

/** The glyph and the app's name in the pixel face ("Silicon Remind"), as the bars show it. */
export function Wordmark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <span className={[styles.wordmark, className].filter(Boolean).join(" ")}>
      <AppMark size={size} />
      <span className={styles.name}>{BRAND_NAME}</span>
    </span>
  );
}
