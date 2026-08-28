import { chromium } from "playwright";

/**
 * Two questions, measured on all seventeen Pages at once.
 *
 * 1. Which URL form actually returns the post? The first probe found jknperlis
 *    giving nothing on `www.facebook.com/jknperlis` and the post on both
 *    `/posts` and `m.facebook.com` — so some of the zeroes we have been
 *    reading as "Facebook is flaky" may be our own choice of URL.
 * 2. How long does a full sweep of all seventeen take? Facebook serves a
 *    signed-out visitor exactly one post, so the only defence against missing
 *    one is to come back before the Page posts again. That makes sweep time
 *    the number that decides how much we miss.
 *
 * Throwaway.
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
  const wanted = /^(lihat seterusnya|lihat lagi|see more)$/i;
  for (const el of document.querySelectorAll('div[role="button"], span, a')) {
    if (wanted.test((el.textContent || "").trim())) el.click();
  }
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

/** `/posts` cannot be appended to a `profile.php?id=` URL; use the timeline tab. */
function variant(url, kind) {
  const u = new URL(url);
  if (kind === "m") {
    u.hostname = "m.facebook.com";
    return u.toString();
  }
  if (kind === "posts") {
    if (u.pathname.startsWith("/profile.php")) {
      u.searchParams.set("sk", "timeline");
      return u.toString();
    }
    u.pathname = u.pathname.replace(/\/$/, "") + "/posts";
    return u.toString();
  }
  return url;
}

async function readOne(browser, url) {
  const context = await browser.newContext({
    userAgent: UA,
    locale: "ms-MY",
    viewport: { width: 1280, height: 1400 },
  });
  const page = await context.newPage();
  await page.addInitScript(KILL_DIALOG);
  const seen = new Map();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2500);
    const harvest = async () => {
      for (const p of await page.evaluate(READ_POSTS)) {
        const key = p.text.slice(0, 120);
        seen.set(key, { text: p.text, link: p.link ?? seen.get(key)?.link ?? null });
      }
    };
    await page.evaluate(EXPAND);
    await page.waitForTimeout(1200);
    await harvest();
    for (let i = 0; i < 2; i++) {
      await page.mouse.wheel(0, 2200);
      await page.waitForTimeout(900);
      await harvest();
      await page.waitForTimeout(900);
      await harvest();
    }
    const rows = [...seen.values()];
    return { n: rows.length, linked: rows.filter((r) => r.link).length, ms: Date.now() - t0 };
  } catch (e) {
    return { n: -1, linked: 0, ms: Date.now() - t0, err: e.message.slice(0, 40) };
  } finally {
    await context.close();
  }
}

const URLS = (process.env.PROBE_URLS ?? "").split(",").filter(Boolean);
const browser = await chromium.launch();

for (const kind of ["www", "posts", "m"]) {
  console.log(`\n=================== bentuk: ${kind} ===================`);
  const t0 = Date.now();
  let dapat = 0;
  for (const url of URLS) {
    const target = variant(url, kind);
    const r = await readOne(browser, target);
    if (r.n > 0) dapat++;
    const nama = new URL(url).pathname.replace(/\//g, "") || new URL(url).search.slice(0, 22);
    console.log(
      `  ${nama.slice(0, 30).padEnd(31)} ${String(r.n).padStart(2)} siaran  ${String(r.linked)} pautan  ${String(Math.round(r.ms / 1000)).padStart(3)}s ${r.err ?? ""}`,
    );
  }
  console.log(`  --> ${dapat}/${URLS.length} page memberi siaran, pusingan penuh ${Math.round((Date.now() - t0) / 1000)}s`);
}
await browser.close();
