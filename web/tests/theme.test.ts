import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_BOOT_SCRIPT } from "../lib/theme";

for (const [stored, systemDark, expected] of [
  [null, true, "dark"], [null, false, "light"], ["light", true, "light"],
  ["dark", false, "dark"], ["system", true, "dark"], ["invalid", true, "dark"],
] as const) {
  test(`first paint: stored ${stored}, system dark ${systemDark} resolves to ${expected}`, () => {
    const attributes: Record<string, string> = {};
    const style = { colorScheme: "" };
    runInNewContext(THEME_BOOT_SCRIPT, {
      document: { documentElement: { style, setAttribute: (key: string, value: string) => { attributes[key] = value; } } },
      localStorage: { getItem: () => stored }, matchMedia: () => ({ matches: systemDark }),
    });
    assert.equal(attributes["data-theme"], expected);
    assert.equal(style.colorScheme, expected);
    assert.equal(attributes["data-theme-preference"], stored === "dark" || stored === "light" ? stored : "system");
  });
}
test("blocked storage still paints the system theme before hydration", () => {
  const attributes: Record<string, string> = {};
  runInNewContext(THEME_BOOT_SCRIPT, {
    document: { documentElement: { style: {}, setAttribute: (key: string, value: string) => { attributes[key] = value; } } },
    localStorage: { getItem: () => { throw new Error("Storage blocked"); } }, matchMedia: () => ({ matches: true }),
  });
  assert.equal(attributes["data-theme"], "dark");
});
