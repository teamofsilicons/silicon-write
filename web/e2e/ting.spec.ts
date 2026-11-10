import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { accountsSession, runAccounts, sameOrigin, signIn } from "./support";
import { openComments } from "./doc-support";

test("PDF comments and title update through Ting, then reconnect reconciles missed changes", async ({ browser }) => {
  const context = await accountsSession(browser, "carbon");
  const page = await context.newPage();
  try {
    await signIn(page, runAccounts().carbon.email, "/library");
    const response = await page.request.post("/api/v1/docs/import", {
      headers: sameOrigin(),
      multipart: { file: { name: "hello.pdf", mimeType: "application/pdf", buffer: readFileSync("../e2e/api/fixtures/library/hello.pdf") }, title: "Ting live PDF" },
    });
    expect(response.status(), await response.text()).toBe(201);
    const doc = await response.json();
    const received: Record<string, unknown>[] = [];
    let receiverCount = 0;
    page.on("websocket", socket => {
      if (!socket.url().includes("/v1/ting/live")) return;
      receiverCount++;
      socket.on("framereceived", ({ payload }) => {
        try { received.push(JSON.parse(String(payload))); } catch { /* No JSON means no hint. */ }
      });
    });
    let binds = 0;
    page.on("response", r => { if (r.url().endsWith(`/v1/docs/${doc.id}/notifications`) && r.ok()) binds++; });
    await page.goto(`/d/${doc.id}`);
    await expect.poll(() => binds).toBeGreaterThan(0);
    await expect(page.getByRole("heading", { name: "Ting live PDF", exact: true })).toBeVisible();
    await openComments(page);
    await page.waitForTimeout(600);
    const comment = await page.request.post(`/api/v1/docs/${doc.id}/threads`, {
      headers: sameOrigin(), data: { anchor: { kind: "pdf", rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.1, page: 1 } }, body: "Arrived through the Ting session" },
    });
    expect(comment.status(), await comment.text()).toBe(201);
    await expect(page.getByRole("complementary", { name: "All comments" })).toContainText("Arrived through the Ting session", { timeout: 5000 });
    await expect.poll(() => received.some(m => m.op === "tings" && JSON.stringify(m).includes('"threads"'))).toBe(true);
    const rename = await page.request.patch(`/api/v1/docs/${doc.id}`, { headers: sameOrigin(), data: { title: "Title through Ting" } });
    expect(rename.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: "Title through Ting", exact: true })).toBeVisible({ timeout: 5000 });
    expect(receiverCount).toBe(1);
    await context.setOffline(true);
    const missed = await page.request.patch(`/api/v1/docs/${doc.id}`, { headers: sameOrigin(), data: { title: "Changed while offline" } });
    expect(missed.ok()).toBe(true);
    await context.setOffline(false);
    await expect.poll(() => receiverCount).toBeGreaterThan(1);
    await expect(page.getByRole("heading", { name: "Changed while offline", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/ting-pdf-session.png", fullPage: true });
  } finally { await context.close(); }
});
