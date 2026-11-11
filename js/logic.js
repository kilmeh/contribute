// SPDX-License-Identifier: Apache-2.0
// Pure logic for the contribute-words site: no DOM, no network, no storage.
// Unit tested with `node --test site/contribute/tests/logic.test.js`.

export const BATCH_SIZE = 10;
export const MAX_SKIPS = 3;
export const MIN_MS_PER_WORD = 2000;
export const CONSENT_TEXT_VERSION = "2026-11-11";
// Version 3: country replaced dialect in the intro. Older saved states are discarded.
export const STATE_VERSION = 3;

export const LIMITS = Object.freeze({
  name: 100,
  email: 254,
  countryOther: 100,
  text: 200,
});

export const DIALECTS = Object.freeze([
  "levantine",
  "gulf",
  "egyptian",
  "maghrebi",
  "iraqi",
  "sudanese",
  "other",
]);

// Country whose Arabic the person speaks -> dialect group. The single JS source of
// truth; the SQL copy is kilmeh_private.dialect_of in supabase/schema.sql. Keys are
// in display order (alphabetical by English name); "other" is always last.
export const COUNTRY_DIALECT = Object.freeze({
  DZ: "maghrebi", // Algeria
  BH: "gulf", // Bahrain
  KM: "other", // Comoros
  DJ: "other", // Djibouti
  EG: "egyptian", // Egypt
  IQ: "iraqi", // Iraq
  JO: "levantine", // Jordan
  KW: "gulf", // Kuwait
  LB: "levantine", // Lebanon
  LY: "maghrebi", // Libya
  MR: "maghrebi", // Mauritania
  MA: "maghrebi", // Morocco
  OM: "gulf", // Oman
  PS: "levantine", // Palestine
  QA: "gulf", // Qatar
  SA: "gulf", // Saudi Arabia
  SO: "other", // Somalia
  SD: "sudanese", // Sudan
  SY: "levantine", // Syria
  TN: "maghrebi", // Tunisia
  AE: "gulf", // United Arab Emirates
  YE: "other", // Yemen
});
export const OTHER_COUNTRY = "other";
export const COUNTRY_CODES = Object.freeze(Object.keys(COUNTRY_DIALECT));
export const COUNTRY_CHOICES = Object.freeze([...COUNTRY_CODES, OTHER_COUNTRY]);

/** Dialect group for a country code or "other"; null for anything else. */
export function dialectOf(country) {
  if (country === OTHER_COUNTRY) return "other";
  return Object.hasOwn(COUNTRY_DIALECT, country) ? COUNTRY_DIALECT[country] : null;
}

export const CATEGORIES = Object.freeze([
  "ui-label",
  "programming",
  "everyday-app",
  "greeting-polite",
  "tech-kept-english",
]);

// Deletion code: K-XXXXX-XXXXX over 30 unambiguous symbols (no 0, 1, I, L, O, U).
// 10 symbols x log2(30) = about 49 bits of randomness.
export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_PATTERN = /^K-[2-9A-HJKMNP-TV-Z]{5}-[2-9A-HJKMNP-TV-Z]{5}$/;

const ARABIC_SCRIPT = /\p{Script=Arabic}/u;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;
const WORD_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Whitespace and invisible format characters, same set as the database rule
// (supabase/schema.sql, kilmeh_private.text_ok). Built from code points so this
// source file stays ASCII.
export const INVISIBLE_RANGES = Object.freeze([
  [0x09, 0x0d], [0x20, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0xad, 0xad],
  [0x34f, 0x34f], [0x61c, 0x61c], [0x115f, 0x1160], [0x1680, 0x1680],
  [0x180e, 0x180e], [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x2064],
  [0x2066, 0x206f], [0x2800, 0x2800], [0x3000, 0x3000], [0x3164, 0x3164],
  [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xe0000, 0xe007f],
]);
const INVISIBLE_CLASS = INVISIBLE_RANGES.map(([a, b]) =>
  a === b ? String.fromCodePoint(a) : `${String.fromCodePoint(a)}-${String.fromCodePoint(b)}`,
).join("");
const VISIBLE_CHAR = new RegExp(`[^${INVISIBLE_CLASS}]`, "u");
// Formula start, also behind leading whitespace or invisible characters.
const FORMULA_START = new RegExp(`^[${INVISIBLE_CLASS}]*[=+@-]`, "u");
const LINE_BREAK_OR_TAB = /[\t\n\v\f\r\u0085\u2028\u2029]/;

/**
 * Trim surrounding whitespace only, and treat a value with no visible character
 * (only spaces, zero-width or bidi controls) as empty. Text inside is never changed,
 * so ZWJ, ZWNJ, marks and bidi controls inside real Arabic text are kept.
 */
export function clean(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return VISIBLE_CHAR.test(trimmed) ? trimmed : "";
}

export function startsLikeFormula(value) {
  return FORMULA_START.test(value);
}

/** Length in Unicode code points, which is what Postgres char_length counts. */
export function codePointLength(value) {
  return Array.from(value).length;
}

export function hasArabic(value) {
  return ARABIC_SCRIPT.test(value);
}

export function isEmail(value) {
  return EMAIL.test(value) && codePointLength(value) <= LIMITS.email;
}

function checkText(value, { required, limit, script, singleLine = false }) {
  if (value === "") return required ? "err_required" : null;
  if (codePointLength(value) > limit) return "err_too_long";
  if (FORMULA_START.test(value)) return "err_formula";
  if (singleLine && LINE_BREAK_OR_TAB.test(value)) return "err_single_line";
  if (script === "arabic" && !hasArabic(value)) return "err_arabic_script";
  if (script === "latin" && hasArabic(value)) return "err_arabizi_script";
  return null;
}

/**
 * Validate the intro form. Returns { values, errors }; errors maps a field name
 * to a string key, and is empty when the form is valid. Empty optional fields
 * become null so the database stores NULL, never "".
 */
export function validateIntro(raw) {
  const name = clean(raw.name);
  const email = clean(raw.email);
  // Exact match only: no trimming or case folding of the code.
  const country = typeof raw.country === "string" ? raw.country : "";
  const countryOther = clean(raw.countryOther);
  const isOther = country === OTHER_COUNTRY;
  const errors = {};

  const nameErr = checkText(name, { required: false, limit: LIMITS.name, singleLine: true });
  if (nameErr) errors.name = nameErr;

  if (email !== "") {
    const emailErr = checkText(email, { required: false, limit: LIMITS.email, singleLine: true });
    if (emailErr) errors.email = emailErr;
    else if (!isEmail(email)) errors.email = "err_email";
  }

  if (dialectOf(country) === null) errors.country = "err_required";
  if (isOther) {
    const otherErr = checkText(countryOther, {
      required: true,
      limit: LIMITS.countryOther,
      singleLine: true,
    });
    if (otherErr) errors.countryOther = otherErr;
  }

  if (raw.consent !== true) errors.consent = "err_consent";

  const values = {
    name: name === "" ? null : name,
    email: email === "" ? null : email,
    country,
    // Free text only for "other"; must be null for a listed country.
    countryOther: isOther && countryOther !== "" ? countryOther : null,
    // Derived for display and test mode only; the database computes its own.
    dialect: dialectOf(country),
    // Credit by name is only possible when a name was given.
    credit: raw.credit === true && name !== "",
    consent: raw.consent === true,
  };
  return { values, errors };
}

/** Validate one word answer against its pool entry. */
export function validateEntry(word, raw) {
  const kept = raw.keptInEnglish === true;
  const arabic = clean(raw.arabic);
  const arabizi = clean(raw.arabizi);
  const arabicFem = word.gendered ? clean(raw.arabicFeminine) : "";
  const arabiziFem = word.gendered ? clean(raw.arabiziFeminine) : "";
  const errors = {};

  const e1 = checkText(arabic, { required: !kept, limit: LIMITS.text, script: "arabic" });
  if (e1) errors.arabic = e1;
  const e2 = checkText(arabizi, { required: true, limit: LIMITS.text, script: "latin" });
  if (e2) errors.arabizi = e2;
  const e3 = checkText(arabicFem, { required: false, limit: LIMITS.text, script: "arabic" });
  if (e3) errors.arabicFeminine = e3;
  const e4 = checkText(arabiziFem, { required: false, limit: LIMITS.text, script: "latin" });
  if (e4) errors.arabiziFeminine = e4;

  const values = {
    arabic: arabic === "" ? null : arabic,
    arabizi,
    arabicFeminine: arabicFem === "" ? null : arabicFem,
    arabiziFeminine: arabiziFem === "" ? null : arabiziFem,
    keptInEnglish: kept,
  };
  return { values, errors };
}

/** Validate the word pool shape (used by tests and at load time). */
export function validatePool(pool) {
  if (!Array.isArray(pool) || pool.length === 0) return false;
  const ids = new Set();
  for (const w of pool) {
    if (!w || typeof w !== "object") return false;
    if (typeof w.id !== "string" || !WORD_ID.test(w.id) || ids.has(w.id)) return false;
    if (typeof w.word !== "string" || w.word.trim() === "") return false;
    if (typeof w.hint !== "string" || w.hint.trim() === "") return false;
    if (!CATEGORIES.includes(w.category)) return false;
    if (typeof w.gendered !== "boolean") return false;
    if ("gender_note" in w) {
      if (!w.gendered || typeof w.gender_note !== "string" || w.gender_note.trim() === "") {
        return false;
      }
    }
    ids.add(w.id);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/** Default random source: fills a Uint8Array with crypto-strength bytes. */
export function cryptoBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** Uniform integer in [0, max) using rejection sampling (no modulo bias). */
export function randomInt(max, bytes = cryptoBytes) {
  if (!Number.isInteger(max) || max <= 0 || max > 0x10000) throw new RangeError("bad max");
  const limit = 0x10000 - (0x10000 % max);
  for (;;) {
    const b = bytes(2);
    const v = (b[0] << 8) | b[1];
    if (v < limit) return v % max;
  }
}

export function generateDeletionCode(bytes = cryptoBytes) {
  const n = CODE_ALPHABET.length; // 30; bytes below 240 map without bias
  let symbols = "";
  while (symbols.length < 10) {
    for (const b of bytes(16)) {
      if (b < 240 && symbols.length < 10) symbols += CODE_ALPHABET[b % n];
    }
  }
  return `K-${symbols.slice(0, 5)}-${symbols.slice(5)}`;
}

export function generateUuid(bytes = cryptoBytes) {
  const b = bytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Session state (plain JSON so it can live in sessionStorage)
// ---------------------------------------------------------------------------

export function createState(bytes = cryptoBytes) {
  return {
    v: STATE_VERSION,
    lang: null,
    screen: "intro",
    intro: { name: "", email: "", country: "", countryOther: "", credit: false, consent: false },
    contributorId: generateUuid(bytes),
    deletionCode: generateDeletionCode(bytes),
    contributorSent: false,
    bot: false,
    seen: [],
    batch: null,
    lastBatchCount: 0,
    totalSent: 0,
  };
}

const MAX_SAVED_CHARS = 100000;
const MAX_RAW_FIELD = 1000;

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isBool = (v) => typeof v === "boolean";
const isShortString = (v) => typeof v === "string" && v.length <= MAX_RAW_FIELD;
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 100000;

function isIdList(list, known, max) {
  return (
    Array.isArray(list) &&
    list.length <= max &&
    list.every((id) => typeof id === "string" && known.has(id)) &&
    new Set(list).size === list.length
  );
}

function isIntro(v) {
  return (
    isPlainObject(v) &&
    ["name", "email", "countryOther"].every((k) => isShortString(v[k])) &&
    // Unknown or tampered country codes are not restored.
    (v.country === "" || COUNTRY_CHOICES.includes(v.country)) &&
    isBool(v.credit) &&
    isBool(v.consent)
  );
}

function isDraft(v) {
  return (
    isPlainObject(v) &&
    ["arabic", "arabizi", "arabicFeminine", "arabiziFeminine"].every(
      (k) => v[k] === undefined || isShortString(v[k]),
    ) &&
    (v.keptInEnglish === undefined || isBool(v.keptInEnglish))
  );
}

/** A stored answer is valid only if it would pass validation again, unchanged. */
function isAnswer(word, v) {
  if (!isPlainObject(v) || !isBool(v.keptInEnglish)) return false;
  const fields = ["arabic", "arabizi", "arabicFeminine", "arabiziFeminine"];
  if (!fields.every((k) => v[k] === null || isShortString(v[k]))) return false;
  const raw = Object.fromEntries(fields.map((k) => [k, v[k] ?? ""]));
  const { values, errors } = validateEntry(word, { ...raw, keptInEnglish: v.keptInEnglish });
  return Object.keys(errors).length === 0 && fields.every((k) => values[k] === v[k]);
}

function isBatch(b, byId) {
  if (!isPlainObject(b)) return false;
  const known = new Set(byId.keys());
  if (!isIdList(b.order, known, BATCH_SIZE) || b.order.length === 0) return false;
  if (!isIdList(b.skipped, known, MAX_SKIPS)) return false;
  if (b.skipped.some((id) => b.order.includes(id))) return false;
  if (!Number.isInteger(b.index) || b.index < 0 || b.index >= b.order.length) return false;
  if (!isPlainObject(b.answers) || !isPlainObject(b.drafts)) return false;
  for (const [id, a] of Object.entries(b.answers)) {
    if (!b.order.includes(id) || !isAnswer(byId.get(id), a)) return false;
  }
  for (const [id, d] of Object.entries(b.drafts)) {
    if (!b.order.includes(id) || !isDraft(d)) return false;
  }
  // Every word before the current one must have an answer.
  return b.order.slice(0, b.index).every((id) => b.answers[id]);
}

/**
 * Accept a parsed state only if every field has the expected type and range;
 * otherwise return null and the page starts fresh.
 */
export function restoreState(parsed, pool) {
  if (!isPlainObject(parsed) || parsed.v !== STATE_VERSION) return null;
  const byId = new Map(pool.map((w) => [w.id, w]));
  const known = new Set(byId.keys());
  const ok =
    ["intro", "words", "done"].includes(parsed.screen) &&
    [null, "en", "ar"].includes(parsed.lang) &&
    typeof parsed.contributorId === "string" &&
    UUID.test(parsed.contributorId) &&
    typeof parsed.deletionCode === "string" &&
    CODE_PATTERN.test(parsed.deletionCode) &&
    isBool(parsed.contributorSent) &&
    isBool(parsed.bot) &&
    isIntro(parsed.intro) &&
    isIdList(parsed.seen, known, pool.length) &&
    isCount(parsed.lastBatchCount) &&
    isCount(parsed.totalSent) &&
    (parsed.batch === null || isBatch(parsed.batch, byId));
  if (!ok) return null;
  if (parsed.screen === "words" && parsed.batch === null) return null;
  if (parsed.screen === "done" && parsed.batch !== null) return null;
  // Once the contributor row is saved the intro is locked and never shown again.
  if (parsed.screen === "intro" && parsed.contributorSent) return null;
  if (parsed.contributorSent && (parsed.intro.name !== "" || parsed.intro.email !== "")) return null;
  if (parsed.batch) {
    const inBatch = [...parsed.batch.order, ...parsed.batch.skipped];
    if (inBatch.some((id) => parsed.seen.includes(id))) return null;
  }
  return parsed;
}

/** Parse the raw sessionStorage string; anything odd gives null (start fresh). */
export function parseSaved(raw, pool) {
  if (typeof raw !== "string" || raw === "" || raw.length > MAX_SAVED_CHARS) return null;
  try {
    return restoreState(JSON.parse(raw), pool);
  } catch {
    return null;
  }
}

const EMPTY_INTRO = Object.freeze({
  name: "",
  email: "",
  country: "",
  countryOther: "",
  credit: false,
  consent: true,
});

/**
 * The contributor row was accepted by the server: lock the identity for this
 * session and drop the name and email from the stored state.
 */
export function markContributorSaved(state) {
  state.contributorSent = true;
  state.intro = { ...EMPTY_INTRO };
}

/** New contributor id and deletion code (used once, on a deletion-code collision). */
export function regenerateIdentity(state, bytes = cryptoBytes) {
  state.contributorId = generateUuid(bytes);
  state.deletionCode = generateDeletionCode(bytes);
}

function excluded(state) {
  const set = new Set(state.seen);
  if (state.batch) {
    for (const id of state.batch.order) set.add(id);
    for (const id of state.batch.skipped) set.add(id);
  }
  return set;
}

/** Pick a random unseen word id, or null when the pool is used up. */
export function pickWord(pool, exclude, bytes = cryptoBytes) {
  const choices = pool.filter((w) => !exclude.has(w.id));
  if (choices.length === 0) return null;
  return choices[randomInt(choices.length, bytes)].id;
}

export function remainingWords(state, pool) {
  const ex = excluded(state);
  return pool.filter((w) => !ex.has(w.id)).length;
}

/** Start a batch of words. Returns false when the pool is used up. */
export function startBatch(state, pool, bytes = cryptoBytes) {
  state.batch = { order: [], index: 0, answers: {}, drafts: {}, skipped: [] };
  const first = pickWord(pool, excluded(state), bytes);
  if (first === null) {
    state.batch = null;
    return false;
  }
  state.batch.order.push(first);
  state.screen = "words";
  return true;
}

export function currentWordId(state) {
  return state.batch ? state.batch.order[state.batch.index] : undefined;
}

export function skipsLeft(state) {
  return state.batch ? MAX_SKIPS - state.batch.skipped.length : 0;
}

/** Replace the current word with a new one. Skips never count toward the batch. */
export function skipWord(state, pool, bytes = cryptoBytes) {
  const b = state.batch;
  if (!b || skipsLeft(state) <= 0) return false;
  const next = pickWord(pool, excluded(state), bytes);
  if (next === null) return false;
  const current = b.order[b.index];
  b.skipped.push(current);
  delete b.answers[current];
  delete b.drafts[current];
  b.order[b.index] = next;
  return true;
}

export function saveAnswer(state, wordId, values) {
  state.batch.answers[wordId] = values;
  delete state.batch.drafts[wordId];
}

/**
 * Move forward after saving the current answer.
 * Returns "word" when another word is shown, or "complete" when the batch is done
 * (10 answers, or the pool ran out).
 */
export function advance(state, pool, bytes = cryptoBytes) {
  const b = state.batch;
  if (b.index + 1 >= BATCH_SIZE) return "complete";
  if (b.order[b.index + 1] === undefined) {
    const next = pickWord(pool, excluded(state), bytes);
    if (next === null) return "complete";
    b.order.push(next);
  }
  b.index += 1;
  return "word";
}

/** Go back one word. Returns "word", "intro" or "none". */
export function goBack(state) {
  const b = state.batch;
  if (b && b.index > 0) {
    b.index -= 1;
    return "word";
  }
  if (!state.contributorSent) {
    state.screen = "intro";
    return "intro";
  }
  return "none";
}

export function answeredIds(state) {
  const b = state.batch;
  return b ? b.order.filter((id) => b.answers[id]) : [];
}

export function contributorRow(state, introValues) {
  return {
    id: state.contributorId,
    name: introValues.name,
    email: introValues.email,
    // No dialect: the database derives it from country (generated column).
    country: introValues.country,
    country_other: introValues.countryOther,
    credit_by_name: introValues.credit,
    consent: true,
    consent_text_version: CONSENT_TEXT_VERSION,
    deletion_code: state.deletionCode,
  };
}

/** Rows for the entries table. Every row has the same keys (bulk insert needs it). */
export function entryRows(state) {
  return answeredIds(state).map((id) => {
    const a = state.batch.answers[id];
    return {
      contributor_id: state.contributorId,
      word_id: id,
      arabic: a.arabic,
      arabizi: a.arabizi,
      arabic_feminine: a.arabicFeminine,
      arabizi_feminine: a.arabiziFeminine,
      kept_in_english: a.keptInEnglish,
    };
  });
}

/** Record a sent batch and drop personal data that is no longer needed. */
export function finishBatch(state) {
  const b = state.batch;
  const sent = answeredIds(state);
  state.seen = [...state.seen, ...sent, ...b.skipped];
  state.lastBatchCount = sent.length;
  state.totalSent += sent.length;
  markContributorSaved(state);
  state.batch = null;
  state.screen = "done";
}

/** Display only: keep "CC BY 4.0" (and a trailing full stop) on one line with no-break spaces. */
export function glueLicense(text) {
  return text.replace(/CC BY 4\.0/g, "CC\u00a0BY\u00a04.0\u2060");
}

/** Replace {name} placeholders. Output is used with textContent only. */
export function format(template, vars = {}) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}
