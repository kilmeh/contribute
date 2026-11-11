// SPDX-License-Identifier: Apache-2.0
// DOM wiring for the contribute-words site. User data is only ever written with
// textContent or form .value, never as HTML.

import {
  BATCH_SIZE,
  MIN_MS_PER_WORD,
  advance,
  createState,
  currentWordId,
  goBack,
  parseSaved,
  remainingWords,
  saveAnswer,
  skipWord,
  skipsLeft,
  startBatch,
  validateEntry,
  validateIntro,
  validatePool,
} from "./logic.js";
import { arabicComplete, getLang, loadStrings, num, setLang, t } from "./i18n.js";
import {
  createMockSender,
  createNullSender,
  createSender,
  loadConfig,
  submitBatch,
} from "./api.js";
import { renderMarkdown } from "./markdown.js";

const STATE_KEY = "kilmeh.contribute.state";
const $ = (id) => document.getElementById(id);

let pool = [];
let byId = new Map();
let state;
let sender;
let wordShownAt = 0;
let unlockTimer = 0;
let sending = false;

// ---------------------------------------------------------------------------
// Storage (sessionStorage only; every access may throw)
// ---------------------------------------------------------------------------

function persist() {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // private mode or blocked storage: progress is simply not kept
  }
}

function loadSaved() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(STATE_KEY);
  } catch {
    return null;
  }
  const restored = parseSaved(raw, pool);
  if (raw !== null && restored === null) {
    // Corrupt, partial or tampered state: discard it and start fresh.
    try {
      sessionStorage.removeItem(STATE_KEY);
    } catch {
      // ignore
    }
  }
  return restored;
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function show(screenId) {
  for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== screenId;
}

function setError(inputId, key) {
  const input = $(inputId);
  const out = $(`${inputId}-error`);
  if (key) {
    input.setAttribute("aria-invalid", "true");
    out.textContent = t(key);
  } else {
    input.removeAttribute("aria-invalid");
    out.textContent = "";
  }
}

function focusFirstError(form) {
  const bad = form.querySelector("[aria-invalid='true']");
  if (bad) bad.focus();
}

function render() {
  if (state.screen === "intro") renderIntro();
  else if (state.screen === "words") renderWord();
  else renderDone();
}

// ---------------------------------------------------------------------------
// (a) Intro
// ---------------------------------------------------------------------------

const INTRO_FIELDS = [
  ["name", "f-name"],
  ["email", "f-email"],
  ["country", "f-country"],
  ["countryOther", "f-country-other"],
  ["consent", "f-consent"],
];

function readIntro() {
  return {
    name: $("f-name").value,
    email: $("f-email").value,
    country: $("f-country").value,
    countryOther: $("f-country-other").value,
    credit: $("f-credit").checked,
    consent: $("f-consent").checked,
  };
}

function syncIntroDependents() {
  const hasName = $("f-name").value.trim() !== "";
  const credit = $("f-credit");
  credit.disabled = !hasName;
  if (!hasName) credit.checked = false;
  $("f-country-other-wrap").hidden = $("f-country").value !== "other";
}

function renderIntro() {
  const v = state.intro;
  $("f-name").value = v.name;
  $("f-email").value = v.email;
  $("f-country").value = v.country;
  $("f-country-other").value = v.countryOther;
  $("f-credit").checked = v.credit;
  $("f-consent").checked = v.consent;
  syncIntroDependents();
  // Defensive: once saved, the identity cannot be edited in this session.
  for (const el of $("intro-form").elements) {
    if (state.contributorSent && el.id !== "btn-start") el.disabled = true;
  }
  show("screen-intro");
}

function onIntroInput() {
  syncIntroDependents();
  state.intro = readIntro();
  persist();
}

function onIntroSubmit(event) {
  event.preventDefault();
  const raw = readIntro();
  const { errors } = validateIntro(raw);
  for (const [field, id] of INTRO_FIELDS) setError(id, errors[field]);
  if (Object.keys(errors).length > 0) {
    focusFirstError($("intro-form"));
    return;
  }
  if ($("f-website").value !== "") state.bot = true;
  state.intro = raw;
  if (!state.batch) {
    if (!startBatch(state, pool)) {
      state.screen = "done";
      persist();
      render();
      return;
    }
  }
  state.screen = "words";
  persist();
  render();
  $("f-arabic").focus();
}

// ---------------------------------------------------------------------------
// (b) Words
// ---------------------------------------------------------------------------

const WORD_FIELDS = [
  ["arabic", "f-arabic"],
  ["arabizi", "f-arabizi"],
  ["arabicFeminine", "f-arabic-fem"],
  ["arabiziFeminine", "f-arabizi-fem"],
];

function readWord() {
  return {
    arabic: $("f-arabic").value,
    arabizi: $("f-arabizi").value,
    arabicFeminine: $("f-arabic-fem").value,
    arabiziFeminine: $("f-arabizi-fem").value,
    keptInEnglish: $("f-kept").checked,
  };
}

function isLastStep() {
  const b = state.batch;
  return b.index + 1 >= BATCH_SIZE || (b.order[b.index + 1] === undefined && remainingWords(state, pool) === 0);
}

function updateNextButton() {
  const waited = Date.now() - wordShownAt >= MIN_MS_PER_WORD;
  $("btn-next").disabled = sending || !waited;
  const label = $("btn-next-label");
  label.dataset.i18n = isLastStep() ? "btn_send" : "btn_next";
  label.textContent = sending ? t("sending") : t(label.dataset.i18n);
}

function renderWord() {
  const b = state.batch;
  const id = currentWordId(state);
  const word = byId.get(id);
  const answer = b.answers[id] || b.drafts[id];

  $("word-progress").textContent = t("word_progress", {
    current: num(b.index + 1),
    total: num(BATCH_SIZE),
  });
  const bar = $("word-progress-bar");
  bar.max = BATCH_SIZE;
  bar.value = b.index;
  [...$("word-steps").children].forEach((li, i) => {
    li.classList.toggle("is-done", i < b.index);
    li.classList.toggle("is-current", i === b.index);
  });
  $("word-category").textContent = t(`category_${word.category}`);
  $("word-text").textContent = word.word;
  $("word-hint").textContent = word.hint;

  $("f-arabic").value = answer ? answer.arabic || "" : "";
  $("f-arabizi").value = answer ? answer.arabizi || "" : "";
  $("f-arabic-fem").value = answer ? answer.arabicFeminine || "" : "";
  $("f-arabizi-fem").value = answer ? answer.arabiziFeminine || "" : "";
  $("f-kept").checked = answer ? answer.keptInEnglish === true : false;
  $("feminine").hidden = !word.gendered;
  const femNote = $("feminine-note");
  if (word.gender_note) {
    femNote.textContent = word.gender_note;
    femNote.lang = "en";
  } else {
    femNote.textContent = t("feminine_note");
    femNote.removeAttribute("lang");
  }
  for (const [, inputId] of WORD_FIELDS) setError(inputId, null);
  $("send-error").hidden = true;

  // Minimum time per new word before Next is enabled (answered words: no wait).
  clearTimeout(unlockTimer);
  wordShownAt = b.answers[id] ? 0 : Date.now();
  unlockTimer = setTimeout(updateNextButton, MIN_MS_PER_WORD + 50);
  updateNextButton();

  const locked = b.index === 0 && state.contributorSent;
  $("btn-back").disabled = locked;
  $("identity-locked").hidden = !locked;
  const left = skipsLeft(state);
  $("btn-skip").disabled = left <= 0 || remainingWords(state, pool) === 0;
  $("skips-left").textContent = t("skips_left", { n: num(left) });

  show("screen-word");
}

function onWordInput() {
  const id = currentWordId(state);
  if (!state.batch.answers[id]) {
    state.batch.drafts[id] = readWord();
    persist();
  }
}

async function onWordSubmit(event) {
  event.preventDefault();
  if (sending || Date.now() - wordShownAt < MIN_MS_PER_WORD) return;
  const id = currentWordId(state);
  const word = byId.get(id);
  const { values, errors } = validateEntry(word, readWord());
  for (const [field, inputId] of WORD_FIELDS) setError(inputId, errors[field]);
  if (Object.keys(errors).length > 0) {
    focusFirstError($("word-form"));
    return;
  }
  saveAnswer(state, id, values);
  persist();
  if (advance(state, pool) === "word") {
    persist();
    renderWord();
    $("f-arabic").focus();
    return;
  }
  await sendBatch();
}

async function sendBatch() {
  sending = true;
  updateNextButton();
  try {
    const target = state.bot ? createNullSender(sender) : sender;
    const result = await submitBatch(state, target, persist);
    sending = false;
    if (result === "intro-invalid") {
      state.screen = "intro";
      persist();
      render();
      return;
    }
    renderDone();
    $("done-heading").focus();
  } catch (err) {
    console.warn("send failed", err && err.kind, err && err.message);
    sending = false;
    renderWord(); // reflects the identity lock if the contributor was saved
    const box = $("send-error");
    box.textContent = t("err_send");
    box.hidden = false;
  }
}

function onBack() {
  const where = goBack(state);
  persist();
  if (where === "word") renderWord();
  else if (where === "intro") renderIntro();
}

function onSkip() {
  if (skipWord(state, pool)) {
    persist();
    renderWord();
    $("f-arabic").focus();
  }
}

// ---------------------------------------------------------------------------
// (c) Done
// ---------------------------------------------------------------------------

function renderDone() {
  const n = num(state.lastBatchCount);
  $("done-body").textContent = sender.mock ? t("done_body_mock", { n }) : t("done_body", { n });
  $("deletion-code").textContent = state.deletionCode;
  $("copy-status").textContent = "";
  const exhausted = remainingWords(state, pool) === 0;
  $("pool-exhausted").hidden = !exhausted;
  $("btn-more").hidden = exhausted;
  show("screen-done");
}

function onMore() {
  if (startBatch(state, pool)) {
    persist();
    renderWord();
    $("f-arabic").focus();
  } else {
    renderDone();
  }
}

async function onCopy() {
  const code = state.deletionCode;
  try {
    await navigator.clipboard.writeText(code);
    $("copy-status").textContent = t("copied");
  } catch {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($("deletion-code"));
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

// ---------------------------------------------------------------------------
// Privacy dialog
// ---------------------------------------------------------------------------

async function openPrivacy() {
  const body = $("privacy-body");
  let text = "";
  try {
    if (getLang() === "ar") {
      const res = await fetch("privacy.ar.md", { cache: "no-cache", credentials: "omit" });
      text = res.ok ? await res.text() : "";
      if (text.trim().startsWith("TODO")) text = "";
    }
    if (text === "") {
      const res = await fetch("privacy.en.md", { cache: "no-cache", credentials: "omit" });
      text = res.ok ? await res.text() : "";
      body.lang = "en";
      body.dir = "ltr";
    } else {
      body.lang = "ar";
      body.dir = "rtl";
    }
  } catch {
    text = "";
  }
  body.replaceChildren(renderMarkdown(text || t("load_error")));
  $("privacy-dialog").showModal();
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

function applyLang(lang) {
  setLang(lang);
  state.lang = getLang();
  persist();
  if (state.screen === "words") renderWord();
  else if (state.screen === "done") renderDone();
}

function initialLang(params) {
  if (params.get("lang") === "ar" || params.get("lang") === "en") return params.get("lang");
  if (state.lang) return state.lang;
  // Auto-pick Arabic only once the board has written every Arabic string.
  const prefersAr = (navigator.languages || []).some((l) => l.toLowerCase().startsWith("ar"));
  return prefersAr && arabicComplete() ? "ar" : "en";
}

function wire() {
  $("intro-form").addEventListener("input", onIntroInput);
  $("intro-form").addEventListener("change", onIntroInput);
  $("intro-form").addEventListener("submit", onIntroSubmit);
  $("word-form").addEventListener("input", onWordInput);
  $("word-form").addEventListener("submit", onWordSubmit);
  $("btn-back").addEventListener("click", onBack);
  $("btn-skip").addEventListener("click", onSkip);
  $("btn-more").addEventListener("click", onMore);
  $("btn-copy").addEventListener("click", onCopy);
  $("btn-privacy-close").addEventListener("click", () => $("privacy-dialog").close());
  for (const b of document.querySelectorAll("[data-open-privacy]")) {
    b.addEventListener("click", openPrivacy);
  }
  for (const b of document.querySelectorAll("[data-lang-choice]")) {
    b.addEventListener("click", () => applyLang(b.dataset.langChoice));
  }
}

async function main() {
  const params = new URLSearchParams(window.location.search);
  // The intro text is folded behind "How it works" on small screens only.
  $("how").open = window.matchMedia("(min-width: 40rem)").matches;
  try {
    const [, words, cfg] = await Promise.all([
      loadStrings(),
      fetch("words.json", { cache: "no-cache", credentials: "omit" }).then((r) => {
        if (!r.ok) throw new Error(`words.json: HTTP ${r.status}`);
        return r.json();
      }),
      params.get("mock") === "1" ? Promise.resolve(null) : loadConfig(),
    ]);
    if (!validatePool(words)) throw new Error("words.json is invalid");
    pool = words;
    byId = new Map(pool.map((w) => [w.id, w]));
    sender = cfg ? createSender(cfg) : createMockSender();
  } catch (err) {
    console.error(err && err.message);
    show("screen-error");
    return;
  }

  $("mock-banner").hidden = !sender.mock;
  state = loadSaved() || createState();
  setLang(initialLang(params));
  state.lang = getLang();
  persist();
  wire();
  render();
}

main();
