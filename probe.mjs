import { chromium } from "playwright";

/**
 * How many posts can a signed-out visitor actually read from a Facebook Page?
 *
 * The scraper takes two scroll passes when signed out, on the belief that
 * Facebook serves a signed-out visitor only the single most recent post. If
 * that belief is right, nothing here will beat it. If it is wrong, we have
 * been discarding posts we could have had — and a CME announced five minutes
 * before an untitled video is lost for good.
 *
 * Throwaway. Delete once the answer is known.
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const KILL_DIALOG = () => {
  setInterval(() => {
    for (const d of document.querySelectorAll('div[role="dialog"]')) d.remove();
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
    document.body.style.position = "static";
  }, 400);
};

const EXPAND = () => {
  let n = 0;
  const wanted = /^(lihat seterusnya|lihat lagi|see more)$/i;
  for (const el of document.querySelectorAll('div[role="button"], span, a')) {
    if (wanted.test((el.textContent || "").trim())) {
      el.click();
      n++;
    }
  }
  return n;
};

const READ_POSTS = () =>
  [...document.querySelectorAll('div[role="article"]')]
    .map((el) => ({
      text: el.innerText || "",
      link:
        [...el.querySelectorAll("a[href]")]
          .map((a) => a.getAttribute("href") || "")
          .find((h) => !h.includes("comment_id") && /\/posts\/|permalink\.php|story_fbid=|\/videos\/|\/reel\//.test(h)) ?? null,
    }))
    .filter((p) => p.text.length > 60);

/** mbasic renders server-side HTML with no role="article" at all. */
const READ_MBASIC = () =>
  [...document.querySelectorAll("#m_story_permalink_view, div[data-ft], article")]
    .map((el) => ({ text: el.innerText || "", link: null }))
    .filter((p) => p.text.length > 60);

async function tryOne(browser, { label, url, passes, reader }) {
  const context = await browser.newContext({
    userAgent: UA,
    locale: "ms-MY",
    viewport: { width: 1280, height: 1400 },
  });
  const page = await context.newPage();
  await page.addInitScript(KILL_DIALOG);
  const seen = new Map();

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2500);

    const harvest = async () => {
      for (const p of await page.evaluate(reader)) {
        const key = p.text.slice(0, 120);
        const prev = seen.get(key);
        seen.set(key, { text: p.text, link: p.link ?? prev?.link ?? null });
      }
    };

    await page.evaluate(EXPAND);
    await page.waitForTimeout(1200);
    await harvest();

    for (let i = 0; i < passes; i++) {
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(900);
      await harvest();
      await page.waitForTimeout(900);
      if (i % 4 === 3) await page.evaluate(EXPAND);
      await harvest();
    }
    await harvest();

    const rows = [...seen.values()];
    console.log(`\n  ${label.padEnd(26)} ${String(rows.length).padStart(2)} siaran  (${rows.filter((r) => r.link).length} berpautan)`);
    for (const r of rows) {
      console.log(`      ${r.link ? "L" : "-"} ${r.text.replace(/\s+/g, " ").slice(0, 78)}`);
    }
    return rows.length;
  } catch (e) {
    console.log(`\n  ${label.padEnd(26)} GAGAL: ${e.message.slice(0, 70)}`);
    return -1;
  } finally {
    await context.close();
  }
}

const PAGES = (process.env.PROBE_PAGES ?? "NutritionistPerak,HealthofKelantan,jknperlis").split(",");

const browser = await chromium.launch();
for (const p of PAGES) {
  console.log(`\n=================== ${p} ===================`);
  await tryOne(browser, { label: "www, 2 tatal (sekarang)", url: `https://www.facebook.com/${p}`, passes: 2, reader: READ_POSTS });
  await tryOne(browser, { label: "www, 12 tatal", url: `https://www.facebook.com/${p}`, passes: 12, reader: READ_POSTS });
  await tryOne(browser, { label: "www /posts, 12 tatal", url: `https://www.facebook.com/${p}/posts`, passes: 12, reader: READ_POSTS });
  await tryOne(browser, { label: "m.facebook, 12 tatal", url: `https://m.facebook.com/${p}`, passes: 12, reader: READ_POSTS });
  await tryOne(browser, { label: "mbasic, 6 tatal", url: `https://mbasic.facebook.com/${p}`, passes: 6, reader: READ_MBASIC });
}
await browser.close();
