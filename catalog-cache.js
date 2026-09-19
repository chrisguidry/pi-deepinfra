// The on-disk cache the provider and the skill share.
//
// The provider downloads the whole DeepInfra catalog on every refresh, and the
// skill needs exactly those bytes, so both read and write one file rather than
// paying for the same download twice.
//
// Plain JavaScript on purpose. pi loads the extension through jiti and the
// skill runs this file with plain node, and a `.js` specifier resolves under
// both without extra tooling or a build step.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The catalog changes when DeepInfra adds a model or reprices one, which is a
// matter of days, so an hours-long window keeps the download off the network
// without the prices going meaningfully stale. Benchmark sites publish on a
// similar cadence; Epoch's CSV is served with a three-hour max-age of its own.
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
export const SCORES_TTL_MS = 6 * 60 * 60 * 1000;

// The provider writes this one and the skill reads it, so the name lives here.
export const CATALOG_CACHE_FILE = "catalog.json";

export function cacheDirectory() {
  const base = process.env.XDG_CACHE_HOME
    ?? (process.platform === "darwin" ? join(homedir(), "Library", "Caches") : join(homedir(), ".cache"));
  return join(base, "pi-deepinfra");
}

// A cache that cannot be read is a cache miss, not an error. The download it
// avoids is always available as a fallback.
export async function readCache(name) {
  try {
    const entry = JSON.parse(await readFile(join(cacheDirectory(), name), "utf8"));
    if (!entry || typeof entry.fetchedAt !== "number") return null;
    return entry;
  } catch {
    return null;
  }
}

export function isFresh(entry, maxAgeMs, now = Date.now()) {
  return Boolean(entry) && now - entry.fetchedAt <= maxAgeMs;
}

// Rename so a reader never sees a half-written file, and never let a write
// failure reach the caller: the data is already in hand either way.
//
// `fetchedAt` is settable because a revalidated response restarts the window
// without new bytes.
export async function writeCache(name, { data, etag = undefined, fetchedAt = Date.now() }) {
  try {
    const directory = cacheDirectory();
    await mkdir(directory, { recursive: true });
    const target = join(directory, name);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ fetchedAt, etag, data }));
    await rename(temporary, target);
  } catch {
    // Ignored on purpose.
  }
}

// Age in words for the footer, so a run says where its numbers came from
// instead of presenting a cached price as a fresh one.
export function describeAge(entry, now = Date.now()) {
  const minutes = Math.round((now - entry.fetchedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
