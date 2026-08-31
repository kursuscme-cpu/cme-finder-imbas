/**
 * When the post was actually made, read from Facebook's own byline.
 *
 * We used to send `new Date()` — the moment we happened to look — which is
 * only true for a post made seconds ago. Every post carrying a relative date
 * ("Pada petang ini") was therefore dated to the day we read it, not the day
 * it was written.
 *
 * Measured: the Carpal Tunnel session announced by Wellness Hub Perlis on 27
 * August at 15:15 was still that Page's newest post on 30 August. Reading it
 * again produced a second event starting 30 August 16:34 — equal to the scan
 * time, three days after the session ended — and a second "CME baharu" email
 * for a session the user had already missed.
 *
 * Facebook prints the age in the byline and `stripByline` discards it, so read
 * it first. Malay and English abbreviate differently and collide on `h`: jam
 * is an hour, hari is a day. Locale is requested, not guaranteed, so decide
 * from the words Facebook actually rendered beside the post.
 *
 * Returns null when the byline cannot be read. Null is the honest answer, and
 * the app refuses to date a relative post without one — inventing a time is
 * exactly what caused this.
 */
const MALAY_UI = /(Semua reaksi|Suka|Komen|Kongsi|Lihat seterusnya)/i;
const AGE_LINE = /^\s*(\d+)\s?(mgg|thn|[jhmdwsy])\s*(·.*)?$/i;

function postedAtFrom(raw) {
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const unit = MALAY_UI.test(raw)
    ? { s: 1000, m: MIN, j: HOUR, h: DAY, mgg: 7 * DAY, thn: 365 * DAY }
    : { s: 1000, m: MIN, h: HOUR, d: DAY, w: 7 * DAY, y: 365 * DAY };

  for (const line of raw.split("\n").slice(0, 8)) {
    const m = line.match(AGE_LINE);
    if (!m) continue;
    const ms = unit[m[2].toLowerCase()];
    if (ms) return new Date(Date.now() - Number(m[1]) * ms).toISOString();
  }
  return null;
}

export { postedAtFrom };
