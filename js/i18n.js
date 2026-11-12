// SPDX-License-Identifier: Apache-2.0
// Bilingual UI strings. Arabic strings are written by a native speaker (the board);
// until a value is filled in, the English string is shown in its place.

import { format, glueLicense } from "./logic.js?v=2026-11-12e";

export const AR_PLACEHOLDER = "TODO: board Arabic";

let strings = { en: {}, ar: {} };
let lang = "en";

async function loadJson(path) {
  const res = await fetch(path, { cache: "no-cache", credentials: "omit" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function loadStrings() {
  const [en, ar] = await Promise.all([loadJson("strings.en.json"), loadJson("strings.ar.json")]);
  strings = { en, ar };
}

/** True when every Arabic string has been written by the board. */
export function arabicComplete() {
  return Object.keys(strings.en).every((k) => {
    const v = strings.ar[k];
    return typeof v === "string" && v !== "" && v !== AR_PLACEHOLDER;
  });
}

export function getLang() {
  return lang;
}

export function t(key, vars) {
  let s = strings[lang] ? strings[lang][key] : undefined;
  if (typeof s !== "string" || s === "" || s === AR_PLACEHOLDER) s = strings.en[key];
  if (typeof s !== "string") s = key;
  return format(s, vars);
}

/** Numbers use Western digits in both languages (board may change this). */
export function num(n) {
  const locale = lang === "ar" ? "ar-u-nu-latn" : "en";
  return new Intl.NumberFormat(locale).format(n);
}

/** Switch language: sets <html lang dir> and refreshes every data-i18n node. */
export function setLang(next, root = document) {
  lang = next === "ar" ? "ar" : "en";
  const html = root.documentElement;
  html.lang = lang;
  html.dir = lang === "ar" ? "rtl" : "ltr";
  root.title = t("app_title");
  for (const el of root.querySelectorAll("[data-i18n]")) {
    el.textContent = glueLicense(t(el.dataset.i18n));
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
  }
  for (const el of root.querySelectorAll("[data-lang-choice]")) {
    el.setAttribute("aria-pressed", String(el.dataset.langChoice === lang));
  }
}
