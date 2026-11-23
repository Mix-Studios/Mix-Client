/*
 * Shared release resolver.
 *
 * One place knows how a GitHub release maps to downloadable files, so the play
 * screen (app.js) and the instructions page (download.html) can never disagree.
 *
 * A release carries one file per platform (Windows .msi, macOS .dmg for Apple
 * silicon and Intel, Linux .deb/.rpm, plus the plain jar). Assets are scored
 * against each platform so the jar is only a fallback, and every upload carries
 * the SHA-256 GitHub recorded for it (`digest`) — the only hash a page can read,
 * because release downloads are not served with CORS headers.
 *
 * /releases/latest ignores pre-releases, so if it has nothing usable the list is
 * read instead and the newest release with a file wins.
 */
window.MixRelease = (() => {
  const RELEASES_REPO = "Mix-Studios/client-mix";
  const API = `https://api.github.com/repos/${RELEASES_REPO}`;
  const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases/latest`;

  // Both pages share one cached answer, so landing on the instructions page
  // after a click costs no extra request.
  const CACHE_KEY = "mixclient:latest-release";
  const CACHE_TTL = 60 * 1000;

  // Attachments that hold the hashes rather than a download.
  const CHECKSUM_FILE = /^(checksums?|sha-?256sums?)(\.txt|\.sha256)?$/i;

  // Files nobody wants as the client download.
  const IGNORED = [
    /\.blockmap$/i, /\.sha\d*$/i, /\.sig$/i, /\.json$/i, /\.ya?ml$/i, /\.txt$/i, /\.asc$/i,
  ];

  const KNOWN_EXTENSIONS = [
    ".exe", ".msi", ".dmg", ".pkg", ".appimage", ".deb", ".rpm",
    ".tar.gz", ".tar.xz", ".tgz", ".zip", ".jar",
  ];

  const OS_HINTS = {
    windows: /win(?:dows)?[^a-z]|\.msi$|\.exe$/i,
    mac: /mac|osx|darwin/i,
    linux: /linux|ubuntu|debian|fedora|\.deb$|\.rpm$|appimage/i,
  };

  const ARCH_HINTS = {
    arm: /arm64|aarch64|apple[-_ ]?silicon/i,
    intel: /x64|x86_64|amd64|intel/i,
    arm32: /armv7|armhf|arm32/i,
  };

  // One entry per downloadable build. `os` decides which file a visitor gets by
  // default; `arch` separates the two macOS disk images.
  const TARGETS = [
    { id: "windows", os: "windows", label: "WINDOWS", short: "WINDOWS", ext: [".msi", ".exe"], note: "Windows 10 / 11 installer" },
    { id: "mac-arm", os: "mac", arch: "arm", label: "MACOS · APPLE SILICON", short: "MACOS", ext: [".dmg", ".pkg"], note: "M-series Macs" },
    { id: "mac-intel", os: "mac", arch: "intel", label: "MACOS · INTEL", short: "MACOS", ext: [".dmg", ".pkg"], note: "Intel Macs" },
    { id: "linux", os: "linux", label: "LINUX", short: "LINUX", ext: [".deb", ".rpm", ".appimage", ".tar.gz", ".tar.xz"], note: "DEB, RPM or AppImage" },
    { id: "jar", os: "any", label: "ANY OS · JAR", short: "ANY OS", ext: [".jar"], note: "Needs Java 17 or newer" },
  ];

  function detectOS() {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const raw = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || "";
    const p = String(raw).toLowerCase();
    if (/win/.test(p)) return "windows";
    if (/mac|iphone|ipad/.test(p)) return "mac";
    if (/linux|x11|android/.test(p)) return "linux";
    return "other";
  }

  function assetExtension(name) {
    const lower = String(name || "").toLowerCase();
    const multi = [".tar.gz", ".tar.xz"].find((ext) => lower.endsWith(ext));
    return multi || KNOWN_EXTENSIONS.find((ext) => lower.endsWith(ext)) || "";
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
  }

  // A release is a test build when GitHub marks it pre-release, when the tag or
  // name says so (`Test`, `1.2.0-beta.3`, `rc1`), or when the tag is not a plain
  // version (`v1.2.3`) at all. This mirrors the release workflow's rule, so the
  // badge and the pre-release flag always agree.
  function buildKind(release) {
    const tag = String((release && release.tag_name) || "").trim();
    const label = `${(release && release.tag_name) || ""} ${(release && release.name) || ""}`;
    const namedTest = /(^|[^a-z])(test|beta|alpha|preview|snapshot|nightly|canary|rc\d*)([^a-z]|$)/i.test(label);
    const versionShaped = /^v?\d+(\.\d+)*$/i.test(tag);
    const isTest = Boolean(release && release.prerelease) || namedTest || (tag && !versionShaped);
    return isTest
      ? { id: "test", label: "TEST BUILD" }
      : { id: "release", label: "RELEASE BUILD" };
  }

  function isTestRelease(release) {
    return buildKind(release).id === "test";
  }

  function versionOf(release) {
    return (release && (release.tag_name || release.name)) || "latest";
  }

  // Score one attachment against one platform. Files that name a different
  // platform are dropped; the runnable jar stays as a fallback for everything.
  function scoreAsset(asset, target) {
    const name = asset.name.toLowerCase();
    const ext = assetExtension(asset.name);
    if (!ext) return -1;

    if (target.os !== "any") {
      for (const [os, hint] of Object.entries(OS_HINTS)) {
        if (os !== target.os && hint.test(name)) return -1;
      }
      if (target.os !== "windows" && ARCH_HINTS.arm32.test(name)) return -1;
    }

    let score = 0;
    if (target.ext.includes(ext)) score += 20;
    else if (ext === ".jar") score += 4;
    else return -1;

    if (target.arch === "arm") {
      if (ARCH_HINTS.intel.test(name)) score -= 18;
      if (ARCH_HINTS.arm.test(name)) score += 6;
    }
    if (target.arch === "intel") {
      if (ARCH_HINTS.arm.test(name)) score -= 18;
      if (ARCH_HINTS.intel.test(name)) score += 6;
    }

    if (/install|setup/.test(name)) score += 3;
    if (/source|src|debug|symbols/.test(name)) score -= 10;
    return score;
  }

  function pickAsset(assets, target) {
    const ranked = (assets || [])
      .filter((a) => a && a.name && a.browser_download_url)
      .filter((a) => !IGNORED.some((re) => re.test(a.name)))
      .map((a) => ({ asset: a, score: scoreAsset(a, target) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked.length ? ranked[0].asset : null;
  }

  function picksFor(release) {
    return TARGETS
      .map((target) => ({ target, asset: pickAsset(release && release.assets, target) }))
      .filter((entry) => entry.asset);
  }

  // What a visitor on `os` gets when they have not picked anything.
  function primaryPick(picks, os, macPick) {
    const byOs = {
      windows: ["windows"],
      mac: ["mac-arm", "mac-intel"],
      linux: ["linux"],
      other: [],
    }[os] || [];

    // A Mac visitor who picked an architecture keeps it across auto-refreshes.
    const chosen = os === "mac" && macPick && picks.find((entry) => entry.target.id === macPick);
    if (chosen) return chosen;

    for (const id of byOs) {
      const hit = picks.find((entry) => entry.target.id === id);
      if (hit) return hit;
    }
    return picks.find((entry) => entry.target.id === "jar") || picks[0] || null;
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return "";
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }

  function findChecksumAsset(assets) {
    return (assets || []).find(
      (a) => a && a.name && a.browser_download_url && CHECKSUM_FILE.test(a.name),
    ) || null;
  }

  // GitHub reports the upload's hash on the asset itself, so no second request
  // is needed (and release downloads would be blocked by CORS anyway).
  function digestOf(asset) {
    const digest = asset && asset.digest;
    if (typeof digest !== "string") return null;
    const match = digest.trim().match(/^sha256:([a-f0-9]{64})$/i);
    return match ? match[1].toLowerCase() : null;
  }

  // checksums.txt is written by `sha256sum <file>`: "<64 hex chars>  <filename>".
  function parseChecksum(text, filename) {
    const wanted = String(filename || "").toLowerCase();
    for (const line of String(text || "").split(/\r?\n/)) {
      const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
      if (match && match[2].trim().toLowerCase() === wanted) return match[1].toLowerCase();
    }
    return null;
  }

  function assetUrl(name, tag) {
    if (!tag) return RELEASES_URL;
    return `https://github.com/${RELEASES_REPO}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
  }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && Date.now() - parsed.at < CACHE_TTL ? parsed.data : null;
    } catch (err) {
      return null;
    }
  }

  function writeCache(data) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data }));
    } catch (err) {
      /* storage disabled — ignore */
    }
  }

  async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, data: await res.json() };
  }

  function newestUsableRelease(list) {
    for (const release of list || []) {
      if (!release || release.draft) continue;
      if (picksFor(release).length) return release;
    }
    return null;
  }

  // The main download must never be a test build while a stable one exists, so
  // the list is searched for the newest release that is not a pre-release.
  function newestStableRelease(list) {
    for (const release of list || []) {
      if (!release || release.draft) continue;
      if (isTestRelease(release)) continue;
      if (picksFor(release).length) return release;
    }
    return null;
  }

  // The full published list, newest first, for pages that show more than one
  // build (the test-builds page). `undefined` means the API failed.
  async function listReleases() {
    const list = await getJson(`${API}/releases?per_page=30`);
    if (!list.ok || !Array.isArray(list.data)) return undefined;
    return list.data.filter((release) => release && !release.draft);
  }

  // `null` means there is no published release, `undefined` means the API failed.
  // A test build is only ever returned when nothing stable exists at all, so a
  // Test tag can never take over the download button.
  async function resolveRelease() {
    const latest = await getJson(`${API}/releases/latest`);
    const latestData = latest.ok ? latest.data : null;

    if (latestData && !isTestRelease(latestData) && picksFor(latestData).length) {
      return latestData;
    }

    const list = await getJson(`${API}/releases?per_page=20`);
    if (list.ok && Array.isArray(list.data)) {
      const stable = newestStableRelease(list.data);
      if (stable) return stable;

      const any = newestUsableRelease(list.data);
      if (any) return any;
    }

    if (latestData) return latestData;
    return latest.status === 404 ? null : undefined;
  }

  return {
    RELEASES_REPO,
    RELEASES_URL,
    CACHE_KEY,
    CACHE_TTL,
    TARGETS,
    detectOS,
    assetExtension,
    escapeHtml,
    buildKind,
    isTestRelease,
    versionOf,
    pickAsset,
    picksFor,
    primaryPick,
    formatSize,
    findChecksumAsset,
    digestOf,
    parseChecksum,
    assetUrl,
    readCache,
    writeCache,
    resolveRelease,
    listReleases,
  };
})();
