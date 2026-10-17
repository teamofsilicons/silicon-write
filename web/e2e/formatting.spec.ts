import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { sameOrigin, statePath } from "./support";

test.use({ storageState: statePath("carbon") });

test("imported inline formatting survives opening and editing in the browser", async ({ page }) => {
  await page.route("https://example.test/dot.png", route => route.fulfill({
    contentType: "image/png",
    body: readFileSync("../e2e/api/fixtures/formats/dot.png"),
  }));
  const source = [
    'Before [![Dot](https://example.test/dot.png "Image caption")](https://example.com/image "Image link") after.',
    'Water H<sub>2</sub>O, x<sup>2</sup>, [reference](https://example.com/reference "Reference title") and [[Target|Alias]].',
    '| Left | Right |\n| :--- | ---: |\n| one | two |',
    'Last paragraph.',
  ].join("\n\n") + "\n";
  const response = await page.request.post("/api/v1/docs", {
    headers: sameOrigin(), data: { title: "Formatting survives browser edits", markdown: source },
  });
  expect(response.status()).toBe(201);
  const doc = await response.json() as { id: string };
  await page.goto(`/d/${doc.id}`);
  const editor = page.locator(".ProseMirror");
  await expect(editor).toBeVisible();
  const picture = editor.locator("p img[data-inline-image]");
  await expect(picture).toHaveAttribute("title", "Image caption");
  await expect(picture).toHaveCSS("display", "inline-block");
  await expect(editor.locator('a[href="https://example.com/image"]')).toHaveAttribute("title", "Image link");
  await expect(editor.locator('a[href="https://example.com/reference"]')).toHaveAttribute("title", "Reference title");
  await expect(editor.locator("sub")).toHaveText("2");
  await expect(editor.locator("sup")).toHaveText("2");
  await expect(editor.locator("[data-doc-link] a")).toHaveText("Alias");
  await expect(editor.locator("th").nth(1)).toHaveCSS("text-align", "right");
  await editor.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Edited.");
  await expect.poll(async () => {
    const r = await page.request.get(`/api/v1/docs/${doc.id}/markdown`);
    return (await r.json() as { markdown: string }).markdown;
  }).toContain("Edited.");
  const saved = await page.request.get(`/api/v1/docs/${doc.id}/markdown`);
  const markdown = (await saved.json() as { markdown: string }).markdown;
  for (const fragment of ["Image caption", "Image link", "Reference title", "[[Target|Alias]]", "<sub>2</sub>", "<sup>2</sup>"]) {
    expect(markdown).toContain(fragment);
  }
});
