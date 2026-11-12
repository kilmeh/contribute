// SPDX-License-Identifier: Apache-2.0
// Sending contributions. Real mode posts to the Supabase REST API (INSERT only,
// Prefer: return=minimal, nothing is ever read back). Mock mode only logs to the
// console and keeps a copy, without name or email, in sessionStorage.

import {
  contributorRow,
  dialectOf,
  entryRows,
  finishBatch,
  markContributorSaved,
  regenerateIdentity,
  validateIntro,
} from "./logic.js?v=2026-11-12d";

export const MOCK_KEY = "kilmeh.contribute.mock-submissions";
const TIMEOUT_MS = 15000;
const PLACEHOLDER_MARK = "YOUR-";

// The only responses treated as "already saved": a unique violation (Postgres
// 23505, HTTP 409) on exactly this constraint, which happens when a retry repeats
// a request whose response was lost. Everything else is an error.
export const ALREADY_SAVED = Object.freeze({
  contributors: "contributors_pkey",
  entries: "entries_contributor_word_key",
});
export const DELETION_CODE_CONSTRAINT = "contributors_deletion_code_key";

export class SendError extends Error {
  /** kind: "http" | "network" | "deletion_code_conflict" */
  constructor(kind, message, status = 0) {
    super(message);
    this.name = "SendError";
    this.kind = kind;
    this.status = status;
  }
}

/** Returns { url, key } for a usable config, or null (then the site runs in mock mode). */
export function parseConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return null;
  const url = typeof cfg.supabaseUrl === "string" ? cfg.supabaseUrl.trim() : "";
  const key = typeof cfg.supabaseAnonKey === "string" ? cfg.supabaseAnonKey.trim() : "";
  if (url === "" || key === "" || url.includes(PLACEHOLDER_MARK) || key.includes(PLACEHOLDER_MARK)) {
    return null;
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url.replace(/\/+$/, ""))) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

export async function loadConfig() {
  try {
    const mod = await import("../config.js");
    return parseConfig(mod.default);
  } catch {
    return null; // config.js missing: mock mode
  }
}

function headers(key) {
  const h = {
    apikey: key,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };
  // Legacy anon keys are JWTs and go in Authorization too; new publishable keys do not.
  if (!key.startsWith("sb_publishable_")) h.Authorization = `Bearer ${key}`;
  return h;
}

async function readError(res) {
  try {
    const body = await res.json();
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

function isUniqueViolationOn(status, detail, constraint) {
  return (
    status === 409 &&
    detail.code === "23505" &&
    typeof detail.message === "string" &&
    detail.message.includes(`"${constraint}"`)
  );
}

async function post(cfg, fetchImpl, table, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${cfg.url}/rest/v1/${table}`, {
      method: "POST",
      headers: headers(cfg.key),
      body: JSON.stringify(body),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new SendError("network", `${table}: ${err && err.name ? err.name : "network error"}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.ok) return;
  const detail = await readError(res);
  if (isUniqueViolationOn(res.status, detail, ALREADY_SAVED[table])) return;
  if (table === "contributors" && isUniqueViolationOn(res.status, detail, DELETION_CODE_CONSTRAINT)) {
    throw new SendError("deletion_code_conflict", "deletion code already used", res.status);
  }
  throw new SendError("http", `${table}: HTTP ${res.status}`, res.status);
}

export function createSender(cfg, fetchImpl = (...args) => globalThis.fetch(...args)) {
  return {
    mock: false,
    sendContributor: (row) => post(cfg, fetchImpl, "contributors", row),
    sendEntries: (rows) => (rows.length > 0 ? post(cfg, fetchImpl, "entries", rows) : undefined),
  };
}

function mockStore(record) {
  try {
    const prev = JSON.parse(sessionStorage.getItem(MOCK_KEY) || "[]");
    prev.push(record);
    sessionStorage.setItem(MOCK_KEY, JSON.stringify(prev));
  } catch {
    // storage unavailable: console only
  }
}

export function createMockSender() {
  return {
    mock: true,
    async sendContributor(row) {
      console.info("[kilmeh test mode] contributor, not sent:", row);
      // Name and email are never stored in test mode, only whether they were given.
      const { name, email, ...rest } = row;
      mockStore({
        at: new Date().toISOString(),
        contributor: {
          ...rest,
          name_given: name !== null,
          email_given: email !== null,
          // What the database would derive (generated column); never sent.
          dialect_derived: dialectOf(rest.country),
        },
      });
    },
    async sendEntries(rows) {
      console.info("[kilmeh test mode] entries, not sent:", rows);
      mockStore({ at: new Date().toISOString(), entries: rows });
    },
  };
}

/** Honeypot was filled: pretend success, send and store nothing. */
export function createNullSender(base) {
  return { mock: base.mock, async sendContributor() {}, async sendEntries() {} };
}

/**
 * Send the current batch: the contributor row once per session, then the entries.
 * The contributor is marked saved (and the identity locked) as soon as the server
 * accepts it, so a retry after an entries failure sends only the entries.
 * A deletion-code collision regenerates the id and code and retries once.
 * Returns "sent" or "intro-invalid"; throws SendError on failure.
 */
export async function submitBatch(state, sender, persist = () => {}) {
  if (!state.contributorSent) {
    const intro = validateIntro(state.intro);
    if (Object.keys(intro.errors).length > 0) return "intro-invalid";
    let regenerated = false;
    for (;;) {
      try {
        await sender.sendContributor(contributorRow(state, intro.values));
        break;
      } catch (err) {
        if (err instanceof SendError && err.kind === "deletion_code_conflict" && !regenerated) {
          regenerated = true;
          regenerateIdentity(state);
          persist();
          continue;
        }
        throw err;
      }
    }
    markContributorSaved(state);
    persist();
  }
  await sender.sendEntries(entryRows(state));
  finishBatch(state);
  persist();
  return "sent";
}
