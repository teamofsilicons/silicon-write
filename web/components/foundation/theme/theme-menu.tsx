"use client";

import { useEffect } from "react";
import { SunMoon } from "lucide-react";
import { useTheme } from "./use-theme";
import { applyTheme, currentTheme, subscribeTheme, themePreference, type ThemePreference } from "@/lib/theme";
import { Button } from "@/components/silicon-ui/button/button";
import { DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/silicon-ui/dropdown-menu/dropdown-menu";

/** Keep system preference and other tabs in sync even on pages without a theme control. */
export function ThemeSync() {
  useEffect(() => {
    applyTheme(currentTheme(), themePreference());
    return subscribeTheme(() => {});
  }, []);
  return null;
}

function ThemeChoices() {
  const { preference, set } = useTheme();
  return <DropdownMenuRadioGroup value={preference} onValueChange={value => set(value as ThemePreference)}>
    <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
    <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
    <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
  </DropdownMenuRadioGroup>;
}

export function ThemeSubmenu() {
  return <DropdownMenuSub>
    <DropdownMenuSubTrigger icon={<SunMoon size={16} />}>Appearance</DropdownMenuSubTrigger>
    <DropdownMenuSubContent aria-label="Appearance"><ThemeChoices /></DropdownMenuSubContent>
  </DropdownMenuSub>;
}

export function ThemeMenu() {
  return <DropdownMenuRoot>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label="Appearance"><SunMoon size={18} /></Button></DropdownMenuTrigger>
    <DropdownMenuContent aria-label="Appearance"><ThemeChoices /></DropdownMenuContent>
  </DropdownMenuRoot>;
}
