/*
 * Direct download from the newest published release, for every platform.
 *
 * A release carries one file per platform (Windows .msi, macOS .dmg for Apple
 * silicon and Intel, Linux .deb/.rpm, plus the plain jar). We ask GitHub for the
 * newest release, score its assets against each platform, and point the big
 * button at the file for this computer. Every other platform gets its own card,
 * so nobody has to visit the releases page to find their build.
 *
 * /releases/latest ignores pre-releases, so if it has nothing usable we fall back
 * to listing releases and take the newest one that actually has a file.
 *
 * The same release says whether it is a test build (pre-release, or a tag like
 * `Test`, `1.0.0-beta`) or a release build, and ships a checksums.txt (sha256sum
 * layout). Once a file is picked we read that file and show its SHA-256 in the
 * "verify" section, so visitors can check an unsigned build themselves.
 *
 * The page keeps itself current: release metadata is re-read every few minutes
 * and whenever the tab comes back, so publishing a release updates the site
 * without anyone pressing Refresh or reloading.
 */
(() => {
  // Builds live in their own repository, separate from this site.
  const RELEASES_REPO = "Mix-Studios/client-mix";
  const API = `https://api.github.com/repos/${RELEASES_REPO}`;
  const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases/latest`;
  const DOWNLOAD_PAGE = "download.html";

  const CACHE_KEY = "mixclient:latest-release";
  const CACHE_TTL = 60 * 1000;                 // a page load reuses a minute-old answer
  const AUTO_REFRESH_MS = 5 * 60 * 1000;       // then the page polls on its own
  const VISIBILITY_MIN_MS = 60 * 1000;         // returning to the tab refreshes if stale

  const buttons = [...document.querySelectorAll("[data-download]")];
  const versionChip = document.getElementById("versionChip");
  const kindEls = [...document.querySelectorAll("[data-build-kind]")];
  const platformsEl = document.querySelector("[data-platforms]");

  // Release integrity elements (see the "verify" section in index.html).
  const shaHashEl = document.querySelector("[data-sha-hash]");
  const shaFileEl = document.querySelector("[data-sha-file]");
  const shaCopyEl = document.querySelector("[data-sha-copy]");
  const shaLinkEl = document.querySelector("[data-sha-link]");
  const shaNameEls = [...document.querySelectorAll("[data-sha-name]")];

  // Launcher chrome: the build card and the status line under the play button.
  const statusEl = document.querySelector("[data-status]");
  const buildNameEl = document.querySelector("[data-build-name]");
  const buildDetailEl = document.querySelector("[data-build-detail]");
  const refreshBtn = document.querySelector("[data-refresh]");

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

  const state = { release: null, picks: [], primary: null };
  let lastApplied = 0;
  let inFlight = null;

  const OS = detectOS();

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

  // A release is a test build when GitHub marks it pre-release, or when the tag
  // or name says so (`Test`, `1.2.0-beta.3`, `rc1`).
  function buildKind(release) {
    const label = `${(release && release.tag_name) || ""} ${(release && release.name) || ""}`;
    const isTest = Boolean(release && release.prerelease) ||
      /test|beta|alpha|preview|snapshot|nightly|canary|\brc\d*\b/i.test(label);
    return isTest
      ? { id: "test", label: "TEST BUILD" }
      : { id: "release", label: "RELEASE BUILD" };
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

  // What the big button hands this visitor.
  function primaryPick(picks) {
    const byOs = {
      windows: ["windows"],
      mac: ["mac-arm", "mac-intel"],
      linux: ["linux"],
      other: [],
    }[OS] || [];

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

  function clock() {
    try {
      return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (err) {
      return "now";
    }
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setBuild(name, detail) {
    if (buildNameEl) buildNameEl.textContent = name;
    if (buildDetailEl) buildDetailEl.textContent = detail;
  }

  function setKind(kind) {
    kindEls.forEach((el) => {
      if (!kind) {
        el.hidden = true;
        el.removeAttribute("data-kind");
        return;
      }
      el.hidden = false;
      el.textContent = kind.label;
      el.dataset.kind = kind.id;
    });
  }

  function renderPlatforms(picks, currentId) {
    if (!platformsEl) return;
    platformsEl.textContent = "";

    if (!picks.length) {
      const empty = document.createElement("p");
      empty.className = "platforms-empty";
      empty.textContent = "This release has no files attached yet.";
      platformsEl.appendChild(empty);
      return;
    }

    picks.forEach(({ target, asset }) => {
      const card = document.createElement("a");
      card.className = "platform" + (target.id === currentId ? " is-current" : "");
      card.href = asset.browser_download_url;
      card.dataset.asset = asset.browser_download_url;
      card.dataset.target = target.id;
      card.title = `${asset.name} · ${target.note}`;
      card.innerHTML =
        `<span class="platform-name">${escapeHtml(target.label)}</span>` +
        `<span class="platform-meta">${escapeHtml(target.note)}</span>` +
        `<span class="platform-file">${escapeHtml(asset.name)}` +
        `${asset.size ? ` · ${escapeHtml(formatSize(asset.size))}` : ""}</span>`;
      platformsEl.appendChild(card);
    });
  }

  function findChecksumAsset(assets) {
    return (assets || []).find(
      (a) => a && a.name && a.browser_download_url && CHECKSUM_FILE.test(a.name),
    ) || null;
  }

  // GitHub reports the upload's hash on the asset itself. Reading it needs no
  // second request, and release downloads don't send CORS headers, so this is
  // the only way the page can see the value.
  function digestOf(asset) {
    const digest = asset && asset.digest;
    if (typeof digest !== "string") return null;
    const match = digest.trim().match(/^sha256:([a-f0-9]{64})$/i);
    return match ? match[1].toLowerCase() : null;
  }

  function showHash(hash) {
    if (!shaHashEl) return;
    delete shaHashEl.dataset.state;
    shaHashEl.textContent = hash;
    shaHashEl.dataset.hash = hash;
    if (shaCopyEl) shaCopyEl.hidden = false;
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

  function setChecksumMissing(message) {
    if (!shaHashEl) return;
    shaHashEl.dataset.state = "missing";
    shaHashEl.textContent = message;
    delete shaHashEl.dataset.hash;
    if (shaCopyEl) shaCopyEl.hidden = true;
  }

  async function loadChecksum(release, asset) {
    if (!shaHashEl) return;

    const checksums = findChecksumAsset(release && release.assets);
    const releaseUrl = release && release.tag_name
      ? `https://github.com/${RELEASES_REPO}/releases/tag/${encodeURIComponent(release.tag_name)}`
      : RELEASES_URL;
    if (shaLinkEl) shaLinkEl.href = checksums ? checksums.browser_download_url : releaseUrl;

    if (!asset) return;

    if (shaFileEl) shaFileEl.textContent = asset.name;
    shaNameEls.forEach((el) => { el.textContent = asset.name; });

    const known = digestOf(asset);
    if (known) {
      showHash(known);
      return;
    }

    if (!checksums) {
      setChecksumMissing("This release has no checksums.txt yet.");
      return;
    }

    try {
      const res = await fetch(checksums.browser_download_url, { cache: "no-store" });
      if (!res.ok) throw new Error(`checksums.txt: HTTP ${res.status}`);

      const hash = parseChecksum(await res.text(), asset.name);
      if (!hash) throw new Error("file missing from checksums.txt");

      showHash(hash);
    } catch (err) {
      setChecksumMissing("GitHub didn't publish this file's hash — open checksums.txt on the release page.");
    }
  }

  function setButtons(url, { state: buttonState, label, meta } = {}) {
    buttons.forEach((el) => {
      el.href = url;
      if (buttonState) el.dataset.state = buttonState;
      else el.removeAttribute("data-state");

      const labelEl = el.querySelector("[data-label]");
      const metaEl = el.querySelector("[data-meta]");
      if (labelEl && label) labelEl.textContent = label;
      if (metaEl && meta) metaEl.textContent = meta;
      if (!metaEl && meta) el.title = meta;
      el.dataset.asset = buttonState === "empty" ? "" : (url || "");
    });
  }

  function buttonLabel(target) {
    if (!target) return "DOWNLOAD";
    if (target.id === "jar") return "DOWNLOAD THE JAR";
    return `DOWNLOAD FOR ${target.short || target.label}`;
  }

  function applyRelease(release) {
    state.release = release;
    lastApplied = Date.now();

    const version = versionOf(release);
    const kind = buildKind(release);
    const picks = picksFor(release);
    state.picks = picks;
    setKind(kind);

    if (!picks.length) {
      state.primary = null;
      setButtons(DOWNLOAD_PAGE, {
        state: "empty",
        label: "NO FILES YET",
        meta: `Release ${version} has no files attached yet`,
      });
      setBuild(`MixClient ${version}`, "This release has no files attached yet.");
      setStatus(`Release ${version} has no download yet.`);
      renderPlatforms([], null);
      loadChecksum(release, null);
      return;
    }

    const primary = primaryPick(picks);
    state.primary = primary;

    const { target, asset } = primary;
    const meta = [version, formatSize(asset.size), asset.name].filter(Boolean).join(" · ");
    const size = formatSize(asset.size);

    setBuild(
      `MixClient ${version}`,
      `${asset.name}${size ? ` · ${size}` : ""} · unsigned`,
    );
    setStatus(`Ready · ${target.short || target.label} build · checked ${clock()}`);

    setButtons(asset.browser_download_url, {
      label: buttonLabel(target),
      meta,
    });

    renderPlatforms(picks, target.id);

    if (versionChip) {
      versionChip.hidden = false;
      versionChip.textContent = version;
      versionChip.title = `Latest release: ${version} (${kind.label.toLowerCase()})`;
    }

    loadChecksum(release, asset);
  }

  function applyEmpty() {
    state.release = null;
    state.picks = [];
    state.primary = null;
    setKind(null);
    setButtons(DOWNLOAD_PAGE, {
      state: "empty",
      label: "NO BUILDS YET",
      meta: "The first release appears here automatically",
    });
    setBuild("No build published yet", "The first release appears here automatically.");
    setStatus("No release published yet — this page checks again on its own.");
    renderPlatforms([], null);
  }

  function applyFailure() {
    state.picks = [];
    state.primary = null;
    setKind(null);
    setButtons(DOWNLOAD_PAGE, {
      state: "empty",
      label: "OPEN LATEST RELEASE",
      meta: "Couldn't reach GitHub — trying again shortly",
    });
    setBuild("Couldn't reach GitHub", "The page retries by itself; Refresh checks right now.");
    setStatus("Couldn't reach GitHub — retrying automatically.");
    renderPlatforms([], null);
  }

  function newestUsableRelease(list) {
    for (const release of list || []) {
      if (!release || release.draft) continue;
      if (picksFor(release).length) return release;
    }
    return null;
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

  async function resolveRelease() {
    const latest = await getJson(`${API}/releases/latest`);
    if (latest.ok && latest.data) return latest.data;

    // 404 means no published (non-prerelease) release; look at the list instead.
    const list = await getJson(`${API}/releases?per_page=10`);
    if (list.ok && Array.isArray(list.data)) return newestUsableRelease(list.data);

    return latest.status === 404 ? null : undefined;
  }

  async function load({ force = false, silent = false } = {}) {
    if (inFlight) return inFlight;

    if (!force) {
      const cached = readCache();
      if (cached) {
        applyRelease(cached);
        return;
      }
    }

    if (!silent) setStatus("Checking the latest release…");

    inFlight = (async () => {
      try {
        const release = await resolveRelease();
        if (release === null) {
          applyEmpty();
          return;
        }
        if (release === undefined) throw new Error("GitHub API unavailable");
        writeCache(release);
        applyRelease(release);
      } catch (err) {
        applyFailure();
      }
    })();

    try {
      await inFlight;
    } finally {
      inFlight = null;
    }
  }

  // Launcher-style Refresh: drop the cached release and ask GitHub again.
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      try {
        sessionStorage.removeItem(CACHE_KEY);
      } catch (err) {
        /* storage disabled — nothing cached anyway */
      }
      refreshBtn.disabled = true;
      load({ force: true }).finally(() => { refreshBtn.disabled = false; });
    });
  }

  // Auto-update: no reload, no clicking. A new release changes the labels and
  // links in place within a few minutes.
  setInterval(() => { load({ force: true, silent: true }); }, AUTO_REFRESH_MS);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (Date.now() - lastApplied < VISIBILITY_MIN_MS) return;
    load({ force: true, silent: true });
  });

  window.addEventListener("online", () => { load({ force: true, silent: true }); });

  if (shaCopyEl && shaHashEl) {
    shaCopyEl.addEventListener("click", async () => {
      const hash = shaHashEl.dataset.hash;
      if (!hash) return;
      try {
        await navigator.clipboard.writeText(hash);
        shaCopyEl.textContent = "COPIED";
        setTimeout(() => { shaCopyEl.textContent = "COPY"; }, 1600);
      } catch (err) {
        /* clipboard blocked — the hash is still selectable */
      }
    });
  }

  // Where the instructions page lives, carrying the file that was clicked and
  // every file in the release so other platforms can be picked there too.
  function instructionsUrl(pick) {
    const params = new URLSearchParams();

    if (state.release) {
      params.set("version", versionOf(state.release));
      params.set("kind", buildKind(state.release).id);
      if (state.release.tag_name) params.set("tag", state.release.tag_name);
    }

    if (pick) {
      params.set("platform", pick.target.id);
      params.set("file", pick.asset.name);
      if (pick.asset.size) params.set("size", String(pick.asset.size));
    }

    if (state.picks.length) {
      params.set("files", state.picks
        .map(({ target, asset }) => `${target.id}:${asset.size || 0}:${asset.name}`)
        .join("|"));
    }

    const query = params.toString();
    return query ? `${DOWNLOAD_PAGE}?${query}` : DOWNLOAD_PAGE;
  }

  // Hand the file to the browser without a page navigation cancelling it:
  // a detached link click starts the transfer in place.
  function startDownload(url) {
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  // Download first, then land on the instructions page instead of GitHub.
  function beginDownload(pick, url) {
    if (!url) {
      window.location.href = instructionsUrl(pick);
      return;
    }

    startDownload(url);
    // A short beat so the browser has begun the transfer before we leave.
    setTimeout(() => { window.location.href = instructionsUrl(pick); }, 400);
  }

  buttons.forEach((el) => {
    el.addEventListener("click", (event) => {
      event.preventDefault();
      beginDownload(state.primary, el.dataset.asset || el.href);
    });
  });

  if (platformsEl) {
    platformsEl.addEventListener("click", (event) => {
      const card = event.target.closest("[data-target]");
      if (!card) return;
      event.preventDefault();
      const pick = state.picks.find((entry) => entry.target.id === card.dataset.target) || state.primary;
      beginDownload(pick, card.dataset.asset || card.href);
    });
  }

  load();
})();
