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

/**
 * Sign in with a session cookie, when one is supplied.
 *
 * Signed out, Facebook shows a visitor the single most recent post per Page
 * and nothing scrolling can reveal. Signed in, the whole feed loads — one
 * visit returns a week of posts instead of one, which is the difference
 * between hoping we looked at the right minute and simply having them all.
 *
 * Cookies, not a username and password. The login form is the most heavily
 * defended part of the site and typing into it from a datacentre address
 * triggers a checkpoint immediately; replaying an existing session does not.
 * It also means no password is stored anywhere — the secret is a session that
 * can be revoked from Facebook's own security page at any time.
 *
 * FB_COOKIES holds what the browser already has: either a raw
 * "c_user=…; xs=…" header string, or the JSON array a cookie exporter gives.
 * Empty or expired, everything falls back to the signed-out path rather than
 * failing — a thinner scrape still beats no scrape.
 */
function parseCookies(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain?.includes("facebook.com") ? c.domain : ".facebook.com",
      path: c.path || "/",
    }));
  }
  return trimmed
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf("=");
      return {
        name: pair.slice(0, i).trim(),
        value: pair.slice(i + 1).trim(),
        domain: ".facebook.com",
        path: "/",
      };
    })
    .filter((c) => c.name && c.value);
}

let SIGNED_IN = false;
let HAVE_SESSION = false;

async function newContext(browser, useSession) {
  const context = await browser.newContext({
    userAgent: UA,
    locale: "ms-MY",
    viewport: { width: 1280, height: 1400 },
  });

  const raw = process.env.FB_COOKIES;
  if (!useSession || !raw?.trim()) {
    SIGNED_IN = false;
    return context;
  }

  try {
    const cookies = parseCookies(raw);
    // `c_user` is the account id and `xs` the session; without both, Facebook
    // treats the visit as signed out and we would never notice.
    const names = new Set(cookies.map((c) => c.name));
    if (!names.has("c_user") || !names.has("xs")) {
      console.log("FB_COOKIES tiada c_user/xs - imbasan dalam dilangkau.");
      SIGNED_IN = false;
      return context;
    }
    await context.addCookies(cookies);
    SIGNED_IN = true;
    HAVE_SESSION = true;
  } catch (e) {
    console.log(`FB_COOKIES tidak boleh dibaca (${e.message}).`);
    SIGNED_IN = false;
  }
  return context;
}

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

/**
 * Each post's text, and the permalink to that actual post.
 *
 * We used to send only the Page URL, so "siaran asal" in the app dropped the
 * user on the Page's front door and left them to scroll for the post we were
 * describing — by which time it may not even be on the first screen any more.
 * The link is a promise to show the evidence; the front door is not evidence.
 *
 * Facebook does render a permalink inside each article, wrapped in tracking
 * parameters. Ranked because one article carries several: the canonical
 * `/posts/` link first, then video and reel forms. Anything pointing at a
 * comment is skipped — that is a reply, not the post.
 */
const READ_POSTS = () => {
  const RANK = [/\/posts\//, /permalink\.php/, /story_fbid=/, /\/videos\//, /\/reel\//, /\/photo/];

  const tidy = (href) => {
    try {
      const u = new URL(href, location.origin);
      for (const k of [...u.searchParams.keys()]) {
        // `__cft__`, `__tn__`, `ref`, `rdid` are click tracking; the rest of a
        // permalink.php query is the post's identity and must survive.
        if (k.startsWith("__") || ["ref", "rdid", "notif_id", "notif_t"].includes(k)) {
          u.searchParams.delete(k);
        }
      }
      u.hash = "";
      return u.toString();
    } catch {
      return null;
    }
  };

  return [...document.querySelectorAll('div[role="article"]')]
    .map((el) => {
      let best = null;
      let bestRank = RANK.length;
      for (const a of el.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        if (href.includes("comment_id")) continue;
        const rank = RANK.findIndex((re) => re.test(href));
        if (rank >= 0 && rank < bestRank) {
          bestRank = rank;
          best = href;
        }
      }
      return {
        text: el.innerText || "",
        link: best ? tidy(best) : null,
      };
    })
    .filter((p) => p.text.length > 60);
};

/**
 * Turn Facebook's innerText back into something a person can read.
 *
 * innerText puts every text node on its own line, so a paragraph breaks
 * wherever a link or a bold run sits inside it — one real post arrived with a
 * single URL split across four lines. Flattening everything to one line fixed
 * the URLs and destroyed the paragraphs, which is what made a stored post
 * unreadable: title, date, speakers and hashtags all run together.
 *
 * Rejoin only what was cut mid-phrase. Facebook leaves the evidence in the
 * whitespace: a source line that ends in a space was interrupted between
 * words, and one that ends in a hyphen or slash with no space was interrupted
 * inside a URL — which must be closed up with nothing between.
 *
 * ponytail: punctuation and whitespace heuristics, not a DOM parser. It
 * restores the shape of ordinary posts; a paragraph ending without punctuation
 * may still be joined to the next. Upgrade path is walking the element tree
 * rather than reading innerText.
 */
function reflow(raw) {
  const out = [];
  let openEnded = false; // previous source line stopped between words
  let urlCut = false; // ...or inside a URL

  for (const source of raw.split("\n")) {
    const text = source.replace(/[^\S\n]+/g, " ").trim();
    if (!text) {
      openEnded = urlCut = false;
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }

    const prev = out.length ? out[out.length - 1] : null;
    if (prev) {
      if (urlCut) out[out.length - 1] = prev + text;
      else if (openEnded && !/[.!?:;]$/.test(prev)) out[out.length - 1] = `${prev} ${text}`;
      else out.push(text);
    } else {
      out.push(text);
    }

    const endsWithSpace = /\s$/.test(source);
    openEnded = endsWithSpace;
    urlCut = !endsWithSpace && /[-/]$/.test(text);
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Everything from the reaction bar down belongs to Facebook and its readers.
 *
 * Below it sit reaction counts and then other people's comments, which were
 * being stored as part of the post and read by the parser as though the
 * organiser had written them.
 */
function stripFooter(text) {
  // "Lihat Sedikit" is appended to the last line rather than given one of its
  // own, so an anchored search walks straight past it.
  text = text.replace(/[ 	]*(?:Lihat Sedikit|See less)[ 	]*$/im, "");
  const cut = text.search(
    /^[ \t]*(?:Semua reaksi|All reactions|Lihat Sedikit|See less|Lihat seterusnya|See more)\b/im,
  );
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

/**
 * "Jabatan Kesihatan Negeri Perlis" / "2j" / "·" — the byline, a line each.
 *
 * Runs before reflow, while the lines are still separate: joined up first, the
 * page name and the post age become one line of prose and cannot be told from
 * the post itself. A shared post carries two of these blocks.
 */
function stripByline(text) {
  const lines = text.split("\n");
  const AGE = /^\s*\d+\s?[jhmdwsy]\s*(·.*)?$/i;
  let start = 0;
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    if (AGE.test(lines[i])) start = i + 1;
  }
  while (start < lines.length && /^[\s·•|-]*$/.test(lines[start])) start++;
  return lines.slice(start).join("\n").trim();
}

async function readPage(context, url) {
  const page = await context.newPage();
  if (!SIGNED_IN) await page.addInitScript(KILL_DIALOG);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // The signed-in Page is a far heavier render — measured returning nothing
    // at 2.8 seconds and five posts at 5. Judging it too early looked exactly
    // like the session had failed.
    await page.waitForTimeout(SIGNED_IN ? 5000 : 2500);

    // Harvest while scrolling, not once at the end.
    //
    // Facebook drops an article out of the DOM as soon as it leaves the
    // viewport, so a feed that has scrolled past twenty posts still holds two
    // or three. Reading once at the bottom was throwing away almost
    // everything the scroll had loaded: measured on JKN Kelantan, seven posts
    // collected on the way down against zero found at the end.
    //
    // `mouse.wheel` rather than `window.scrollBy`, because the real feed
    // sometimes sits in its own scroll container and the window never moves.
    const seen = new Map();
    const harvest = async () => {
      for (const post of await page.evaluate(READ_POSTS)) {
        // Keyed on the opening words, never on the link.
        //
        // The permalink is attached lazily, so the same post is seen first
        // without one and later with. Keying on the link made those two
        // entries; keying on the text makes them one, and the link is kept
        // from whichever pass actually found it.
        const key = post.text.slice(0, 120);
        const prev = seen.get(key);
        seen.set(key, { text: post.text, link: post.link ?? prev?.link ?? null });
      }
    };

    await page.evaluate(EXPAND);
    await page.waitForTimeout(1200);
    await harvest();

    const passes = SIGNED_IN ? 14 : 2;
    for (let i = 0; i < passes; i++) {
      await page.mouse.wheel(0, 2200);
      // Two beats, not one. Text renders first and the permalink is attached
      // a moment later, so a single short pause harvested the words and left
      // the link behind on every post.
      await page.waitForTimeout(900);
      await harvest();
      await page.waitForTimeout(900);
      // Expanding again matters on the way down: each newly loaded post
      // arrives truncated with its own "Lihat seterusnya".
      if (i % 4 === 3) await page.evaluate(EXPAND);
      await harvest();
    }

    // One last look once the feed has stopped moving: permalinks that were
    // still loading during the scroll are attached by now.
    await page.waitForTimeout(1500);
    await harvest();

    if (SIGNED_IN) {
      // A session that has been revoked or expired still loads the Page — it
      // just serves the signed-out view. Without this the run would look
      // healthy while quietly collecting one post per Page again.
      const walled = await page.evaluate(() =>
        Boolean(document.querySelector('input[name="pass"], [data-testid="royal_login_form"]')),
      );
      if (walled) {
        SIGNED_IN = false;
        console.log("  SESI TAMAT - Facebook memaparkan skrin log masuk. Perbaharui FB_COOKIES.");
      }
    }

    return [...seen.values()]
      .map((p) => ({ text: reflow(stripFooter(stripByline(p.text))), link: p.link }))
      .filter((p) => p.text.length > 60);
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

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Every call to the app wakes the database, and Neon's free plan bills the
 * wall-clock time it stays awake — it only sleeps after five idle minutes.
 *
 * Reading Facebook costs nothing, but *telling the app* about posts it already
 * has costs compute hours. Scanning every eight minutes therefore kept the
 * database awake about five minutes in every eight, against five in fifteen
 * before: roughly 110 CU-hours a month against a free allowance of 100.
 *
 * Facebook posts do not change between passes. So remember what was sent last
 * time and stay quiet when nothing is new — which is almost always. Reading
 * stays fast; only the talking is rationed.
 */
let lastSent = "";

/**
 * Two kinds of pass, because signing in trades one thing for another.
 *
 * Measured on the same Pages with the same code: signed out returns exactly
 * one post per Page in about eight seconds, and it always carries the
 * permalink. Signed in returns one to six, takes thirty seconds a Page, and
 * carries no permalink at all — the link is attached a moment after the text
 * and Facebook recycles the article out of the DOM before it arrives.
 *
 * So the quick pass runs every eight minutes and keeps "siaran asal" pointing
 * at the exact post, and a deep signed-in sweep runs roughly hourly to pick up
 * anything the quick pass was too late to see. Both feed the same door and
 * dedup sorts out the overlap. It also keeps the signed-in account down to a
 * few hundred page loads a day rather than over a thousand.
 */
async function pass(deep) {
  const browser = await chromium.launch();
  const context = await newContext(browser, deep);
  const items = [];
  try {
    // A deep sweep reads everything; the quick pass reads its window.
    const turnOf = SIGNED_IN ? pages : window_(pages);
    console.log(
      `Mengimbas ${turnOf.length} daripada ${pages.length} page… ${SIGNED_IN ? "(dalam, log masuk)" : "(pantas)"}`,
    );
    for (const url of turnOf) {
      const posts = await readPage(context, url);
      const berpautan = posts.filter((p) => p.link).length;
      console.log(`  ${posts.length} siaran (${berpautan} berpautan)  ${url}`);
      for (const [i, post] of posts.entries()) {
        items.push({
          text: post.text,
          // Where the user is sent when they ask to see the post for
          // themselves. Falls back to the Page when Facebook renders no
          // permalink — better than nothing, but not the promise we want.
          url: post.link ?? url,
          // Kept separate because attribution matches a source by its exact
          // Page URL. Sending only the permalink would leave every post
          // unattributed.
          pageUrl: url,
          postedAt: new Date().toISOString(),
          // Same post on the next run must produce the same id, or every scan
          // re-ingests everything. Hash the text rather than trusting position.
          id: `${new URL(url).pathname.replace(/\//g, "")}-${hash(post.text)}-${i === 0 ? "top" : "n"}`,
        });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  if (!items.length) {
    console.log("Tiada siaran — kemungkinan Facebook menyekat runner ini.");
    return false;
  }

  const fingerprint = items.map((i) => i.id).sort().join("|");
  if (fingerprint === lastSent) {
    console.log(`  ${items.length} siaran, tiada yang baharu — tidak dihantar`);
    return false;
  }
  lastSent = fingerprint;

  const res = await fetch(`${APP}/api/webhook/masuk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, source: "fb-actions", items }),
  });
  console.log(`  HTTP ${res.status}  ${await res.text()}`);
  return true;
}

/**
 * Ask the app to sweep the mailbox for certificates.
 *
 * We are already awake and waiting between passes, and unlike the app's own
 * cron we are not racing a 30-second client timeout. So the certificate check
 * rides along here every eight minutes instead of once an hour.
 */
async function sweepCertificates() {
  try {
    const res = await fetch(`${APP}/api/webhook/sijil`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: SECRET }),
      signal: AbortSignal.timeout(60_000),
    });
    console.log(`  sijil HTTP ${res.status}  ${await res.text()}`);
  } catch (e) {
    // A mailbox that will not answer must not cost us the Facebook pass.
    console.log(`  sijil GAGAL: ${e.message.split("\n")[0]}`);
  }
}

/**
 * Loop inside one job rather than trusting the schedule.
 *
 * GitHub treats an every-eight-minutes cron as a suggestion. Measured over six
 * consecutive runs, the gaps were 47, 53, 65, 82 and 39 minutes — a
 * high-frequency schedule gets collapsed to roughly hourly under load, which
 * quietly turned a fifteen-minute promise into an hour-and-a-half one. An
 * hourly schedule is honoured reliably, so take the hour and control the
 * minutes ourselves.
 *
 * Runner minutes are free on a public repository, so a job that sits there for
 * most of an hour costs nothing. `concurrency` in the workflow stops a late
 * schedule from stacking two of these on top of each other.
 */
const LOOP_MS = Number(process.env.FB_LOOP_MINUTES ?? 56) * 60_000;
const GAP_MS = Number(process.env.FB_RUN_EVERY_MS ?? 480_000);
const until = Date.now() + LOOP_MS;

for (let n = 1; ; n++) {
  const started = Date.now();
  console.log(`\n--- pusingan ${n} @ ${new Date().toISOString().slice(11, 19)} ---`);
  // Every seventh eight-minute pass is roughly hourly.
  const deep = Boolean(process.env.FB_COOKIES?.trim()) && n % 7 === 1;
  let sent = false;
  try {
    sent = await pass(deep);
  } catch (e) {
    // One bad pass must not end the hour; the next one is minutes away.
    console.log(`  GAGAL: ${e.message.split("\n")[0]}`);
  }

  // Sweep when the database is already awake because we just wrote to it, and
  // otherwise every third pass. Certificates arrive on a scale of days, so a
  // worst case of twenty-four minutes costs the user nothing — whereas waking
  // Neon every eight minutes purely to find an empty mailbox is the difference
  // between staying inside the free plan and leaving it.
  if (sent || n % 3 === 1) await sweepCertificates();

  const next = started + GAP_MS;
  if (next >= until) break;
  const wait = Math.max(0, next - Date.now());
  console.log(`  tidur ${Math.round(wait / 1000)}s`);
  await new Promise((r) => setTimeout(r, wait));
}
console.log("\nSelesai untuk jam ini.");
