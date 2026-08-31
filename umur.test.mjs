import { postedAtFrom } from "./umur.mjs";
import assert from "node:assert/strict";

const now = Date.now();
const jam = (iso) => (iso === null ? null : Math.round((now - Date.parse(iso)) / 60000));

// Shapes taken verbatim from the scraper's own run log, not invented.
const MELAYU_1H = "Nutritionist Perak\n1h\n·\n0:00 / 0:59\nSemua reaksi:\n1\nSuka\nKomen";
const MELAYU_35M = "Jabatan Kesihatan Negeri Perlis\n35m\n·\nPERTANDINGAN VIDEO PENDEK\nSuka\nKomen";
const MELAYU_2J = "Wellness Hub Perlis\n2j\n·\nCARPAL TUNNEL SYNDROME\nSemua reaksi:\nKongsi";
const INGGERIS_2H = "Some Page\n2h\n·\nSomething\nAll reactions\nLike\nComment\nShare";
const TIADA = "Wellness Hub Perlis\n27 Ogos pukul 15:15\n·\nCARPAL TUNNEL SYNDROME\nSuka";

// `h` is the whole point: hari in Malay, hour in English.
assert.equal(jam(postedAtFrom(MELAYU_1H)), 24 * 60, "Melayu 1h mesti sehari");
assert.equal(jam(postedAtFrom(INGGERIS_2H)), 2 * 60, "Inggeris 2h mesti dua jam");
assert.equal(jam(postedAtFrom(MELAYU_35M)), 35, "35m");
assert.equal(jam(postedAtFrom(MELAYU_2J)), 120, "2j mesti dua jam");

// A byline we cannot read must say so, not guess.
assert.equal(postedAtFrom(TIADA), null, "byline tarikh penuh -> null");
assert.equal(postedAtFrom(""), null, "kosong -> null");

// The age must not be picked up from the body, only the head of the post.
const BADAN = ["Page", "·", "a", "b", "c", "d", "e", "f", "g", "3h"].join("\n");
assert.equal(postedAtFrom(BADAN), null, "baris ke-10 diabaikan");

console.log("semua lulus:", [MELAYU_1H, MELAYU_35M, MELAYU_2J, INGGERIS_2H].map((t) => postedAtFrom(t).slice(5, 16)).join("  "));
