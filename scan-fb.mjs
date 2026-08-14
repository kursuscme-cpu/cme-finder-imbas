/**
 * Read Facebook Pages with a real browser and post what it finds to the app.
 *
 * A plain HTTP fetch of a Facebook Page gets a login wall no matter where it
 * runs. A real browser does not — the page content is served, with the login
 * prompt merely painted on top. That is the whole trick, and it means no
 * Apify, no scraping service, and no Facebook account of ours involved.
 *
 * Runs in GitHub Actions. Vercel cannot host this: a serverless function has
 * no room for a browser.
 *
 * Env: CME_FINDER_URL, INGEST_SECRET, optional FB_PAGES (comma separated).
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const APP = process.env.CME_FINDER_URL;
const SECRET = process.env.INGEST_SECRET;
if (!APP || !SECRET) {
  console.error("CME_FINDER_URL dan INGEST_SECRET wajib diset");
  process.exit(1);
}

/**
 * Ask the app which Pages to read.
 *
 * The `sources` table is the list the user actually maintains — the Sumber
 * page shows it and the submission form writes to it. Reading a checked-in
 * text file instead meant two lists that drifted apart without a single error
 * anywhere: `pkebesut` sat in the table unscraped, `NutritionistPerak` was
 * scraped with no row to attribute it to. The file stays as a fallback so a
 * scrape still happens if the app is down mid-deploy.
 */
async function pageList() {
  if (process.env.FB_PAGES) return process.env.FB_PAGES.split(",");
  try {
    const res = await fetch(
      `${APP}/api/webhook/halaman?secret=${encodeURIComponent(SECRET)}`,
      { signal: AbortSignal.timeout(15_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { urls } = await res.json();
    if (!urls?.length) throw new Error("senarai kosong");
    return urls;
  } catch (e) {
    console.log(`Senarai dari app gagal (${e.message}) - guna fail tempatan.`);
    return readFileSync("faebook-cme-page.txt", "utf8").split(/\r?\n/);
  }
}

const pages = (await pageList()).map((s) => s.trim()).filter((s) => s.startsWith("http"));

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Facebook re-inserts the login dialog constantly; it blocks scroll and clicks. */
const KILL_DIALOG = () => {
  setInterval(() => {
    for (const d of document.querySelectorAll('div[role="dialog"]')) d.remove();
    document.documentElement.style.overflow = "auto";
    document.body.style.overflow = "auto";
    document.body.style.position = "static";
  }, 400);
};

/** Posts are truncated until this is pressed. Malay UI and English differ. */
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
    .map((el) => el.innerText.replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 60);

/**
 * "Pejabat Kesihatan Daerah Besut 1j · TAJUK…" — drop the byline prefix.
 *
 * A shared post carries two of them, one for the page that shared it and one
 * for the original author, so this repeats until nothing is left to remove.
 * Anchored and single-replace only ever stripped the first, which left the
 * second sitting in the title.
 */
function stripByline(text) {
  const BYLINE = /^.{0,80}?\s\d+\s?[jhmd]\s·\s/;
  let out = text.trim();
  for (let i = 0; i < 3 && BYLINE.test(out); i++) {
    out = out.replace(BYLINE, "").trim();
  }
  return out;
}

/** Reactions and comment counts trail every post and are noise to the parser. */
function stripFooter(text) {
  return text
    .replace(/\s*(Semua reaksi|All reactions)\s*:.*$/i, "")
    .replace(/\s*\d+\s*(Suka|Like|Komen|Comment|Kongsi|Share)\b.*$/i, "")
    .trim();
}

async function readPage(browser, url) {
  const page = await browser.newPage({ userAgent: UA, locale: "ms-MY", viewport: { width: 1280, height: 1400 } });
  await page.addInitScript(KILL_DIALOG);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForTimeout(2500);

    // Two scrolls, not five. Logged out, Facebook renders what it is going to
    // render on first paint; the extra three passes were 4.5 seconds a page
    // that never once produced another post. That time is worth more spent on
    // looking again sooner.
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 3000));
      await page.waitForTimeout(1200);
    }

    await page.evaluate(EXPAND);
    await page.waitForTimeout(1500);

    const raw = await page.evaluate(READ_POSTS);
    return raw.map((t) => stripFooter(stripByline(t))).filter((t) => t.length > 60);
  } catch (e) {
    console.log(`  GAGAL ${url}: ${e.message.split("\n")[0]}`);
    return [];
  } finally {
    await page.close();
  }
}

/**
 * Read a moving window of the list, not all of it.
 *
 * Facebook stops serving partway through a run. Measured across four
 * consecutive runs: 10 pages returned a post, then 9, then 7, then 7 — and the
 * zeros were always the *tail*, never scattered. So the last entries were not
 * quiet, they were never reached. `UnionMLT`, the page most relevant to a lab
 * technologist, sat last and had never once been read.
 *
 * Since roughly the first eight are all Facebook will serve anyway, reading
 * eight and moving the window on costs almost nothing in yield and halves the
 * time a run takes — which is what buys the frequency. The window advances by
 * its own width each hour, so the pages are partitioned rather than resampled,
 * and every page is visited about thirteen times a day instead of the six or
 * seven it managed before.
 */
const PER_RUN = Number(process.env.FB_PAGES_PER_RUN ?? 8);
/** Must match the workflow schedule, or windows repeat and others are skipped. */
const RUN_EVERY_MS = Number(process.env.FB_RUN_EVERY_MS ?? 480_000);

function window_(list, size = PER_RUN) {
  const n = Math.min(size, list.length);
  // Stepping by the window width partitions the list instead of resampling it.
  // 8 and 15 share no factor, so the start lands on every one of the fifteen
  // positions before it repeats — a window of 10 would only ever start at
  // three of them and starve the rest.
  const turn = Math.floor(Date.now() / RUN_EVERY_MS) * n;
  return Array.from({ length: n }, (_, i) => list[(turn + i) % list.length]);
}

const browser = await chromium.launch();
const items = [];

const turnOf = window_(pages);
console.log(`Mengimbas ${turnOf.length} daripada ${pages.length} page…\n`);
for (const url of turnOf) {
  const posts = await readPage(browser, url);
  console.log(`  ${posts.length} siaran  ${url}`);
  for (const [i, text] of posts.entries()) {
    items.push({
      text,
      url,
      postedAt: new Date().toISOString(),
      // Same post on the next run must produce the same id, or every scan
      // re-ingests everything. Hash the text rather than trusting position.
      id: `${new URL(url).pathname.replace(/\//g, "")}-${hash(text)}-${i === 0 ? "top" : "n"}`,
    });
  }
}
await browser.close();

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

console.log(`\nJumlah ${items.length} siaran. Menghantar…`);
if (!items.length) {
  console.log("Tiada siaran — kemungkinan Facebook menyekat runner ini.");
  process.exit(0);
}

const res = await fetch(`${APP}/api/webhook/masuk`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ secret: SECRET, source: "fb-actions", items }),
});
console.log(`HTTP ${res.status}  ${await res.text()}`);
if (!res.ok) process.exit(1);
