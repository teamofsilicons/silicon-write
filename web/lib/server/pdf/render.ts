import { readFile } from "node:fs/promises";
import { join } from "node:path";
import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { Theme } from "@/lib/theme";

let stylesPromise: Promise<string> | undefined;
let chromiumPath: Promise<string> | undefined;
function printStyles(): Promise<string> {
  stylesPromise ??= (async () => {
    const root = process.cwd();
    const [foundation, tokens, fonts, editor, print, mathFont] = await Promise.all([
      readFile(join(root, "components/silicon-ui/foundation.css"), "utf8"),
      readFile(join(root, "styles/tokens.css"), "utf8"),
      readFile(join(root, "styles/fonts.css"), "utf8"),
      readFile(join(root, "components/editor/editor.module.css"), "utf8"),
      readFile(join(root, "lib/server/pdf/print.css"), "utf8"),
      readFile(join(root, "lib/server/pdf/fonts/STIXTwoMath-Regular.ttf")),
    ]);
    let embedded = fonts;
    for (const match of fonts.matchAll(/url\("(\/fonts\/[^"?#]+\.woff2)"\)/g)) {
      const bytes = await readFile(join(root, "public/fonts", match[1].slice("/fonts/".length)));
      embedded = embedded.replaceAll(match[0], `url("data:font/woff2;base64,${bytes.toString("base64")}")`);
    }
    const math = `@font-face { font-family: "STIX Two Math"; src: url("data:font/ttf;base64,${mathFont.toString("base64")}") format("truetype"); }`;
    return [foundation, tokens, embedded, math, editor.replace(/:global\(([^)]+)\)/g, "$1"), print].join("\n");
  })().catch(error => { stylesPromise = undefined; throw error; });
  return stylesPromise;
}

/** Render the service's self-contained HTML export, with no scripts, cookies or network access. */
export async function renderBeautifulPdf(html: string, theme: Theme, signal?: AbortSignal) {
  const css = await printStyles();
  const localPath = process.env.WRITE_PDF_CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined);
  signal?.throwIfAborted();
  const browser = await puppeteer.launch({
    // Concurrent cold requests share extraction, so none launches a partial binary.
    executablePath: localPath || await (chromiumPath ??= chromium.executablePath().catch(error => { chromiumPath = undefined; throw error; })),
    ...(localPath ? { headless: true as const } : { headless: "shell" as const, args: chromium.args }),
    timeout: 30_000,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    await browser.close().catch(() => {});
  };
  const abort = () => { void close(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", request => {
      // Images are already embedded by the existing export service. Never resolve
      // arbitrary doc URLs (including file:// and internal hosts) from this renderer.
      void (request.url().startsWith("data:") ? request.continue() : request.abort()).catch(() => {});
    });
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const title = await page.title();
    await page.evaluate(selectedTheme => {
      document.querySelectorAll("style, link, script, iframe, object, embed, base, meta[http-equiv]").forEach(node => node.remove());
      document.documentElement.setAttribute("data-theme", selectedTheme);
      const article = document.createElement("article");
      article.className = "prose";
      while (document.body.firstChild) article.append(document.body.firstChild);
      const heading = document.createElement("h1");
      heading.className = "write-title";
      heading.textContent = document.title || "Untitled";
      document.body.replaceChildren(heading, article);
    }, theme);
    await page.addStyleTag({ content: css });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    });
    const source = await page.createPDFStream({ printBackground: true, preferCSSPageSize: true, tagged: true, outline: true, waitForFonts: true, timeout: 30_000 });
    const reader = source.getReader();
    // Stream large PDFs directly; close the isolated renderer on completion or cancellation.
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) { controller.close(); await close(); }
          else controller.enqueue(value);
        } catch (error) { controller.error(error); await close(); }
      },
      async cancel() { await reader.cancel().catch(() => {}); await close(); },
    });
    return { stream, title: title || "Untitled" };
  } catch (error) { await close(); throw error; }
}
