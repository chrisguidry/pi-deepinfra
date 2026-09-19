// Benchmark sources. No number is stored in this repo: each is fetched live,
// with the result kept on disk for a few hours so a burst of questions reads
// the same bytes once.
//
// Both built-in sources are keyless. Coverage is partial either way, so the
// join reports what it could not score rather than quietly ranking a shorter
// list. A leaderboard neither one carries can be piped in with `--scores`.
import { SCORES_TTL_MS, isFresh, readCache, writeCache } from "../../../catalog-cache.js";

export const ARENA_ROWS_URL = "https://datasets-server.huggingface.co/rows";
export const EPOCH_CSV_URL = "https://epoch.ai/data/eci_benchmarks.csv";
export const EPOCH_CACHE_FILE = "epoch-benchmarks.json";

// The Arena dataset paginates 100 rows per request and the rows are ordered by
// category, so the category we want is always in the leading pages.
const ARENA_PAGE_SIZE = 100;
const ARENA_MAX_PAGES = 12;

export function parseCsv(text) {
  const rows = [];
  let field = "";
  let record = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      rows.push(record);
      record = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    rows.push(record);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body
    .filter((row) => row.length === header.length)
    .map((row) => Object.fromEntries(header.map((column, i) => [column, row[i]])));
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// The Hugging Face dataset server answers 502 while it loads an index and 429
// when it has had enough traffic, both of which are temporary. A 304 is a
// successful answer too: it says the copy on disk is still current. Anything
// else is a real error worth surfacing at once.
async function fetchWithRetry(url, { attempts = 3, ...init } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(750 * attempt);
    try {
      const response = await fetch(url, { ...init, headers: { accept: "application/json", ...init.headers } });
      if (response.ok || response.status === 304) return response;
      lastError = new Error(`${url} returned HTTP ${response.status}`);
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function cached(data, entry) {
  return { ...data, origin: { kind: "cache", entry } };
}

function fetched(data) {
  return { ...data, origin: { kind: "network" } };
}

// Human preference from the Arena. Every config but `agent` reports `rating`, a
// Bradley-Terry score on the old Elo scale, so it compares models within one
// leaderboard but carries no absolute meaning. `agent` reports an IPS `score`
// instead, and counts observations rather than votes.
//
// The configs are separate leaderboards, not categories: `webdev` is the Code
// Arena, and it is the one that says anything about coding.
export async function arenaScores({ config = "text_style_control", category = "overall", signal, refresh = false } = {}) {
  const cacheFile = `arena-${config}-${category}.json`;
  const entry = await readCache(cacheFile);
  if (!refresh && isFresh(entry, SCORES_TTL_MS)) return cached(entry.data, entry);

  const scores = new Map();
  let total = Infinity;
  let scanned = 0;

  for (let page = 0; page < ARENA_MAX_PAGES && scanned < total; page += 1) {
    const params = new URLSearchParams({
      dataset: "lmarena-ai/leaderboard-dataset",
      config,
      split: "latest",
      offset: String(page * ARENA_PAGE_SIZE),
      length: String(ARENA_PAGE_SIZE),
    });
    const response = await fetchWithRetry(`${ARENA_ROWS_URL}?${params}`, { signal });
    const payload = await response.json();
    total = payload.num_rows_total ?? 0;
    const rows = payload.rows ?? [];
    scanned += rows.length;
    if (rows.length === 0) break;
    for (const { row } of rows) {
      if (row.category !== category) continue;
      const score = row.rating ?? row.score;
      if (typeof score !== "number") continue;
      const votes = row.vote_count ?? row.observation_count ?? 0;
      const current = scores.get(row.model_name);
      if (!current || votes > current.votes) {
        scores.set(row.model_name, { name: row.model_name, score, votes });
      }
    }
  }

  const result = {
    source: "arena",
    label: `Arena (${config.replace("_style_control", "")}, ${category})`,
    url: "https://arena.ai/leaderboard",
    publishedAt: "latest published snapshot",
    truncated: scanned < total,
    // The agent leaderboard reports an IPS score centred near zero rather than
    // a Bradley-Terry rating, so its scores are signed offsets and a ratio of
    // one to a price says nothing. Order by score and ignore the price column.
    centered: config === "agent",
    scores: [...scores.values()],
  };
  await writeCache(cacheFile, { data: result });
  return fetched(result);
}

// Epoch AI publishes every benchmark result as one long CSV row, so the score
// here is the unweighted mean of each model's normalized benchmark results.
// That is a coarse composite — Epoch's own dashboards weight the benchmarks —
// but it needs no maintained list of which benchmarks to trust.
//
// A `benchmark` pattern narrows the mean to matching benchmark names, which is
// how you get a coding-only composite without hand-picking a list here. An
// asterisk is a wildcard and the match ignores case.
function benchmarkMatcher(pattern) {
  if (!pattern) return null;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

// The whole CSV is cached rather than one pattern's result, because any pattern
// can be derived from it and it is the download worth avoiding. Epoch serves an
// ETag, so a stale copy is revalidated instead of refetched.
async function epochCsv({ signal, refresh = false }) {
  const entry = await readCache(EPOCH_CACHE_FILE);
  if (!refresh && isFresh(entry, SCORES_TTL_MS)) return { text: entry.data, origin: { kind: "cache", entry } };

  const conditional = entry?.etag && !refresh ? { "if-none-match": entry.etag } : {};
  const response = await fetchWithRetry(EPOCH_CSV_URL, {
    signal,
    headers: { accept: "text/csv", ...conditional },
  });

  if (response.status === 304 && entry) {
    // Still current, so the window restarts without moving any bytes.
    await writeCache(EPOCH_CACHE_FILE, { data: entry.data, etag: entry.etag });
    return { text: entry.data, origin: { kind: "revalidated" } };
  }

  const text = await response.text();
  await writeCache(EPOCH_CACHE_FILE, { data: text, etag: response.headers?.get?.("etag") ?? undefined });
  return { text, origin: { kind: "network" } };
}

export async function epochScores({ benchmark, signal, refresh = false } = {}) {
  const { text, origin } = await epochCsv({ signal, refresh });
  const rows = parseCsv(text);
  const matcher = benchmarkMatcher(benchmark);
  const allBenchmarks = new Set(rows.map((row) => row.benchmark).filter(Boolean));

  const byModel = new Map();
  const benchmarksSeen = new Set();
  for (const row of rows) {
    const performance = Number.parseFloat(row.performance);
    if (!row.model || !Number.isFinite(performance)) continue;
    if (matcher && !matcher.test(row.benchmark)) continue;
    benchmarksSeen.add(row.benchmark);
    const entry = byModel.get(row.model) ?? { name: row.model, total: 0, count: 0 };
    entry.total += performance;
    entry.count += 1;
    byModel.set(row.model, entry);
  }

  // An empty result would otherwise surface as "scored 0 of N", which reads as
  // a source that has no data rather than a pattern that matched nothing.
  if (matcher && benchmarksSeen.size === 0) {
    const names = [...allBenchmarks].sort();
    throw new Error(`no Epoch benchmark matched "${benchmark}"; it carries ${names.length}, including ${names.slice(0, 8).join(", ")}`);
  }

  return {
    source: "epoch",
    label: benchmark
      ? `Epoch AI, ${[...benchmarksSeen].sort().join(" / ") || benchmark}`
      : "Epoch AI benchmarks (mean of normalized scores)",
    url: "https://epoch.ai/benchmarks",
    publishedAt: "release dates in the CSV",
    truncated: false,
    benchmarks: [...benchmarksSeen].sort(),
    attribution: "Epoch AI, CC BY",
    origin,
    scores: [...byModel.values()].map((entry) => ({
      name: entry.name,
      score: (entry.total / entry.count) * 100,
      benchmarks: entry.count,
    })),
  };
}

export const SOURCES = {
  arena: arenaScores,
  epoch: epochScores,
};

// An escape hatch for any leaderboard the built-in sources do not carry:
// swe-rebench, LiveBench, a vendor card, a colleague's spreadsheet. Accepts
// `{name: score}`, `[{name, score}]`, or a two-column CSV on stdin.
export function scoresFromJson(text) {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) {
    return parsed.map((entry) => ({ name: entry.name, score: Number(entry.score) }));
  }
  return Object.entries(parsed).map(([name, score]) => ({ name, score: Number(score) }));
}
