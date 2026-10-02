// Loads the unpacked extension into Chromium, opens the demo app, activates
// the guide, asks it something and saves screenshots to playground/shots/.
// Needs the demo app (npm run app) and the guide server (cd ../server && npm run mock).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../extension", import.meta.url));
const shots = fileURLToPath(new URL("./shots/", import.meta.url));
const APP = process.env.APP_URL || "http://localhost:5173";
const headless = !process.env.HEADED;
await mkdir(shots, { recursive: true });

const context = await chromium.launchPersistentContext("", {
  headless,
  channel: "chromium", // the full browser: extensions load in its new headless mode
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});

const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
const page = await context.newPage();
await page.goto(APP);
await page.waitForFunction(() => document.getElementById("guide-extension-root"));
await page.screenshot({ path: `${shots}1-inactive.png` });

// Same as clicking the toolbar icon: the service worker sends "toggle" to the tab
const toggle = () => worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, { type: "toggle" });
});
await toggle();
await page.waitForTimeout(250);
await page.screenshot({ path: `${shots}2-activating.png` });
await page.waitForTimeout(900);
await page.screenshot({ path: `${shots}3-active.png` });

const input = page.locator("#guide-extension-root .text"); // Playwright pierces open shadow roots
await input.fill("How do I create an invoice?");
await input.press("Enter");
await page.locator("#guide-extension-root .ring.on").waitFor({ timeout: 15000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: `${shots}4-pointing.png` });

await page.keyboard.press("Escape");
await page.waitForTimeout(600);
const stillActive = await page.locator("#guide-extension-root .ui.active").count();
await page.screenshot({ path: `${shots}5-closed.png` });
console.log(stillActive ? "FAIL: guide still active after Esc" : `OK: screenshots in ${shots}`);
await context.close();
process.exit(stillActive ? 1 : 0);
