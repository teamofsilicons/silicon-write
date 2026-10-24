import { expect, test } from "@playwright/test";
import { accountsSession, runAccounts, sameOrigin, signIn, storedSession } from "./support";

test("enabling email collection closes an existing CLI stream and invalidates its old live ticket", async ({ browser }) => {
  const owner = await accountsSession(browser, "carbon");
  const page = await owner.newPage();
  await signIn(page, runAccounts().carbon.email, "/library");
  const doc = await (await page.request.post("/api/v1/docs", { headers: sameOrigin(), data: { title: "Email stream policy", markdown: "Read this after sharing an email." } })).json() as { id: string };
  expect((await page.request.put(`/api/v1/docs/${doc.id}/public`, { headers: sameOrigin(), data: { access: "view" } })).ok()).toBeTruthy();
  const friend = await accountsSession(browser, "friend");
  const visitor = await friend.newPage();
  await signIn(visitor, runAccounts().friend.email, "/library");
  const { session } = await storedSession(friend);
  const base = process.env.E2E_API_URL!;
  const auth = { Authorization: `Bearer ${session.at}` };
  const ticket = await (await friend.request.post(`${base}/v1/docs/${doc.id}/live`, { headers: auth, data: {} })).json();
  const response = await fetch(`${base}/v1/docs/${doc.id}/events`, { headers: auth, signal: AbortSignal.timeout(20_000) });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes('event: snapshot')) { const chunk = await reader.read(); expect(chunk.done).toBe(false); text += decoder.decode(chunk.value); }
  expect((await page.request.put(`/api/v1/docs/${doc.id}/public`, { headers: sameOrigin(), data: { access: "view", require_email: true } })).ok()).toBeTruthy();
  while (true) { const chunk = await reader.read(); if (chunk.done) break; text += decoder.decode(chunk.value); }
  expect(text).toContain('"code":"email_required"');
  const oldTicket = await friend.request.get(`${base}/v1/live/${doc.id}?ticket=${encodeURIComponent(ticket.ticket)}`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  expect(oldTicket.status()).toBe(403);
  await visitor.goto(`/d/${doc.id}`);
  await expect(visitor.getByRole("heading", { name: "Enter your email to view" })).toBeVisible();
  await visitor.getByLabel("Email", { exact: true }).fill("unverified-reader@example.com");
  await visitor.getByRole("button", { name: "View file" }).click();
  await expect(visitor.locator(".ProseMirror")).toContainText("Read this after sharing an email.");
  const history = await (await page.request.get(`/api/v1/docs/${doc.id}/viewers`)).json();
  expect(history.viewers).toMatchObject([{ email: "unverified-reader@example.com", email_source: "entered" }]);
  await friend.close(); await owner.close();
});
