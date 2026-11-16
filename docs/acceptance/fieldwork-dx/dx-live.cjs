const { chromium } = require("@playwright/test");
const fs = require("fs");
(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/chat") && r.request().method() === "POST") {
      try {
        fs.writeFileSync("evidence/dx-live-plan-stream.txt", await r.text());
      } catch {}
    }
  });
  await page.goto("http://127.0.0.1:3218");
  await page.getByRole("button", { name: /Demo-Arbeitsplatz/ }).click();
  await page.waitForURL("http://127.0.0.1:3218/");
  await page.getByRole("button", { name: "KI fragen", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "evidence/dx-live-open.png", fullPage: true });
  const start = Date.now();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/chat") && r.request().method() === "POST",
    { timeout: 90000 },
  );
  await page
    .getByRole("textbox", { name: "Was kann ich für dich übernehmen?" })
    .fill("Prüfe dringende Aufträge, die Qualifikationen im Team und den Materialbestand. Arbeite mit einer Plan-Checkliste. Nur lesen, nichts ändern. Fasse am Ende alle drei Ergebnisse zusammen.");
  await page.getByRole("button", { name: "Senden", exact: true }).click();
  const r = await response;
  await r.finished();
  console.log("CHAT_MS", Date.now() - start, "HTTP", r.status());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "evidence/dx-live-plan.png", fullPage: true });
  console.log(
    "EDITORS",
    await page
      .locator("[contenteditable],textarea,input")
      .evaluateAll((els) =>
        els.map((e) => ({
          tag: e.tagName,
          role: e.getAttribute("role"),
          placeholder: e.getAttribute("placeholder"),
          label: e.getAttribute("aria-label"),
        })),
      ),
  );
  console.log((await page.locator("body").innerText()).slice(-8000));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
