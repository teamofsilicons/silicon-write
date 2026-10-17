/**
 * Focus goes back to what opened a layer when it closes (WCAG 2.4.3), however it was opened.
 *
 * Radix's modal Dialog returns focus only to its own <Dialog.Trigger>. Most layers here open from controlled state (a
 * plain button, a menu item, a command, a key), so there is no Trigger and focus fell to <body> when they closed.
 * `useReturnFocus(open)` remembers what had focus when `open` turned true and hands the layer's content an
 * `onCloseAutoFocus` that puts focus back there:
 *
 * - it is captured in an insertion effect, which runs before anything in the layer can take focus (an `autoFocus`
 *   field is focused in the layout phase, Radix's FocusScope moves focus in a passive effect); under a bare Radix root,
 *   where `open` is unknown, `onOpenAutoFocus` captures it instead;
 * - the caller's own `onCloseAutoFocus` runs first, and one that calls `preventDefault()` keeps its own target;
 * - nothing remembered (focus was on <body>, or the element is gone): Radix's own behaviour, its Trigger if any;
 * - focus already moved on to something outside the layer while it left (a command opened another layer, a link was
 *   followed): it stays there.
 */
import { useInsertionEffect, useRef } from "react";

/** What has focus now, unless that is nothing in particular (<body>). */
function focusedElement(): HTMLElement | null {
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export interface ReturnFocusHandlers {
  onOpenAutoFocus: (event: Event) => void;
  onCloseAutoFocus: (event: Event) => void;
}

/**
 * `open`: the layer's open state (null or undefined when the caller cannot know it). `onOpenAutoFocus` /
 * `onCloseAutoFocus`: the caller's own handlers, composed (they run first).
 */
export function useReturnFocus(open: boolean | null | undefined, onOpenAutoFocus?: (event: Event) => void, onCloseAutoFocus?: (event: Event) => void): ReturnFocusHandlers {
  const opener = useRef<HTMLElement | null>(null);
  useInsertionEffect(() => {
    if (open) opener.current = focusedElement();
  }, [open]);
  return {
    onOpenAutoFocus(event) {
      if (open === null || open === undefined) opener.current = focusedElement();
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus(event) {
      onCloseAutoFocus?.(event);
      const target = opener.current;
      opener.current = null;
      const layer = event.currentTarget instanceof Element ? event.currentTarget : null;
      if (event.defaultPrevented || !target?.isConnected || layer?.contains(target)) return;
      event.preventDefault();
      const active = document.activeElement;
      if (active && active !== document.body && !layer?.contains(active)) return;
      target.focus();
    },
  };
}
