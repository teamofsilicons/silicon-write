import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import {
  accountsSession,
  runAccounts,
  sameOrigin,
  signIn,
  storedSession,
  API,
} from "./support";
import { docSyncState } from "./doc-support";

test("a separate browser frontend creates, edits and exports without Write cookies", async ({
  browser,
}) => {
  const signed = await accountsSession(browser, "carbon");
  const standalone = await browser.newContext();
  const host = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Standalone Write interface</title>");
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  try {
    await signIn(await signed.newPage(), runAccounts().carbon.email);
    const token = (await storedSession(signed)).session.at;
    const page = await standalone.newPage();
    await page.goto(
      "http://127.0.0.1:" + (host.address() as AddressInfo).port + "/demo",
    );
    const result = await page.evaluate(
      async ({ origin, token }) => {
        const call = (path: string, method = "GET", data?: unknown) =>
          fetch(origin + path, {
            method,
            credentials: "omit",
            headers: {
              Authorization: "Bearer " + token,
              ...(data ? { "Content-Type": "application/json" } : {}),
            },
            body: data ? JSON.stringify(data) : undefined,
          });
        const created = await call("/v1/docs", "POST", {
          title: "Browser interface",
          markdown: "First",
        });
        const doc = (await created.json()).id;
        const edit = await call("/v1/docs/" + doc + "/edits", "POST", {
          edits: [{ old: "First", new: "Reviewed" }],
        });
        const content = await call("/v1/docs/" + doc + "/markdown");
        const pdf = await call(
          "/v1/docs/" + doc + "/beautiful-pdf?theme=light",
        );
        const prefix = new TextDecoder().decode(
          (await pdf.arrayBuffer()).slice(0, 5),
        );
        return {
          created: created.status,
          edit: edit.status,
          text: (await content.json()).markdown,
          pdf: pdf.status,
          prefix,
        };
      },
      { origin: API, token },
    );
    expect(result).toEqual({
      created: 201,
      edit: 200,
      text: "Reviewed\n",
      pdf: 200,
      prefix: "%PDF-",
    });
  } finally {
    await signed.close();
    await standalone.close();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
  }
});

test("paste Markdown blocks, reopen source and scroll half a viewport past the last line", async ({
  browser,
}) => {
  const ctx = await accountsSession(browser, "carbon", {
    viewport: { width: 1120, height: 760 },
  });
  try {
    const page = await ctx.newPage();
    await signIn(page, runAccounts().carbon.email);
    const doc = await (
      await page.request.post("/api/v1/docs", {
        headers: sameOrigin(),
        data: { title: "Markdown editing" },
      })
    ).json();
    await page.goto("/d/" + doc.id);
    await expect(docSyncState(page)).toHaveAccessibleName(
      "Connected and synced",
    );
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await editor.click();
    await editor.evaluate((el) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/plain",
        "## Draft\n\n- **First** item\n- Second item",
      );
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        }),
      );
    });
    await expect(editor.getByRole("heading", { level: 2 })).toHaveText("Draft");
    await expect(editor.locator("li strong")).toHaveText("First");
    await page.keyboard.press("ControlOrMeta+Shift+M");
    const source = page.getByRole("textbox", { name: "Markdown source" });
    await expect(source).toContainText("## Draft");
    await source.fill(
      "# Revised\n\n" +
        Array.from({ length: 45 }, (_, i) => "Paragraph " + (i + 1)).join(
          "\n\n",
        ),
    );
    await page.getByRole("button", { name: "Save Markdown" }).click();
    await expect(editor.locator("h1")).toHaveText("Revised");
    await expect(editor.locator("p").last()).toHaveText("Paragraph 45");
    const spacing = await editor.evaluate((el) => {
      let parent = el.parentElement;
      while (
        parent &&
        !(
          parent.scrollHeight > parent.clientHeight + 3 &&
          /auto|scroll/.test(getComputedStyle(parent).overflowY)
        )
      )
        parent = parent.parentElement;
      const scroll = parent ?? document.scrollingElement!;
      scroll.scrollTop = scroll.scrollHeight;
      const end = el.lastElementChild!.getBoundingClientRect().bottom;
      return {
        gap:
          (parent?.getBoundingClientRect().bottom ?? window.innerHeight) - end,
        height: window.innerHeight,
      };
    });
    expect(spacing.gap).toBeGreaterThan(spacing.height * 0.45);
  } finally {
    await ctx.close();
  }
});

test("save a trusted contact in Write, find them by a fuzzy name and preview before sharing", async ({
  browser,
}) => {
  test.skip(
    process.env.WRITE_INTEGRATION_FIXTURES !== "1",
    "Requires the local Silicon Contacts service.",
  );
  const ctx = await accountsSession(browser, "carbon");
  const peer = runAccounts().friend;
  try {
    const page = await ctx.newPage();
    await signIn(page, runAccounts().carbon.email);
    await page.getByRole("button", { name: "Contacts", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Silicon Contacts" });
    await dialog
      .getByRole("button", { name: "Connect Silicon Contacts" })
      .click();
    await dialog
      .getByRole("combobox", { name: "Contact account" })
      .fill(peer.id);
    await dialog.getByLabel("Saved name").fill("Notebook collaborator");
    await dialog.getByLabel(/Trust/).fill("235");
    await dialog.getByRole("button", { name: "Add contact" }).click();
    await expect(
      dialog.getByRole("list", { name: "Saved contacts" }),
    ).toContainText("Notebook collaborator");
    await page.keyboard.press("Escape");
    const doc = await (
      await page.request.post("/api/v1/docs", {
        headers: sameOrigin(),
        data: { title: "Contact preview" },
      })
    ).json();
    await page.goto("/d/" + doc.id);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const sharing = page.getByRole("dialog", { name: "Share", exact: true });
    const input = sharing.getByRole("combobox", { name: "Who to share with" });
    await input.fill("ntbkcl");
    await sharing
      .getByRole("option", { name: /Notebook collaborator/ })
      .click();
    await expect(input).toHaveValue(peer.id);
    await expect(
      sharing.getByText("Notebook collaborator", { exact: true }),
    ).toBeVisible();
    await sharing.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      sharing.getByRole("combobox", { name: "Role of " + peer.id }),
    ).toBeVisible();
  } finally {
    await ctx.request.put("/api/v1/contacts/connection", {headers: sameOrigin(), data: {connected: false}});
    await ctx.close();
  }
});

test("an administrator configures a default and shares with an organization team from the editor", async ({
  browser,
}) => {
  test.skip(
    process.env.WRITE_INTEGRATION_FIXTURES !== "1",
    "Requires the loopback Organizations fixture database.",
  );
  const owner = await accountsSession(browser, "carbon");
  const friend = await accountsSession(browser, "friend");
  try {
    const page = await owner.newPage(),
      guest = await friend.newPage();
    await signIn(page, runAccounts().carbon.email);
    await signIn(guest, runAccounts().friend.email);
    const account = async (ctx: typeof owner) =>
      (await storedSession(ctx)).session.acct;
    const admin = await account(owner),
      member = await account(friend);
    const id = "browser-" + Date.now().toString(36),
      team = "Studio " + id;
    const state = {
      org_id: id,
      name: "Write " + id,
      created_at: 1,
      version: 1,
      members: {
        [admin.uuid]: {
          ...admin,
          pfp_url: admin.pfp_url ?? "",
          owner: true,
          joined_at: 1,
        },
        [member.uuid]: {
          ...member,
          pfp_url: member.pfp_url ?? "",
          joined_at: 1,
        },
      },
      teams: { studio: { id: "studio", name: team, members: [member.uuid] } },
    };
    const sql =
      process.env.PSQL ??
      (existsSync("/opt/homebrew/opt/postgresql@16/bin/psql")
        ? "/opt/homebrew/opt/postgresql@16/bin/psql"
        : "psql");
    execFileSync(
      sql,
      [
        "-X",
        "-q",
        "-h",
        "127.0.0.1",
        "-p",
        "5471",
        "-U",
        "postgres",
        "-d",
        "write_orgs_e2e",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "id=" + id,
        "-v",
        "state=" + JSON.stringify(state),
      ],
      {
        input:
          "insert into organizations(org_id,state,created_at,updated_at) values(:'id',:'state'::jsonb,1,1);",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    await page.reload();
    await page.getByRole("button", { name: "Organization settings" }).click();
    const form = page
      .getByRole("dialog", { name: "Organization settings" })
      .locator("form")
      .filter({ hasText: state.name });
    await form.getByLabel("Default sharing role").selectOption("commenter");
    await form.getByRole("button", { name: "Save settings" }).click();
    await expect(
      form.getByRole("button", { name: "Save settings" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    const doc = await (
      await page.request.post("/api/v1/docs", {
        headers: sameOrigin(),
        data: { title: "Shared team minutes", markdown: "Minutes" },
      })
    ).json();
    await page.goto("/d/" + doc.id);
    await page.getByRole("button", { name: "Share", exact: true }).click();
    const sharing = page.getByRole("dialog", { name: "Share", exact: true });
    await sharing
      .getByRole("combobox", { name: "Who to share with" })
      .fill(team);
    await sharing.getByRole("option", { name: new RegExp(team) }).click();
    await expect(
      sharing.getByRole("combobox", { name: "Role", exact: true }),
    ).toContainText("Suggester");
    await sharing.getByRole("button", { name: "Share", exact: true }).click();
    await expect(
      sharing.getByText("team:" + id + "/studio", { exact: true }),
    ).toBeVisible();
    await guest.goto("/d/" + doc.id);
    await expect(
      guest.getByRole("button", { name: "Mode: Suggesting" }),
    ).toBeVisible();
  } finally {
    await owner.close();
    await friend.close();
  }
});
