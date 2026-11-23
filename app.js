/*
 * Direct download from the latest published release.
 *
 * Buttons carry `data-download`; their label/meta children carry `data-label` and
 * `data-meta`. On load we ask GitHub for the newest release of the builds repo,
 * pick the installer for the visitor's OS, and point every button straight at that
 * asset. Visitors never land on a releases page, and publishing a release updates
 * the site without a rebuild.
 *
 * /releases/latest ignores pre-releases, so if it has nothing usable we fall back
 * to listing releases and take the newest one that actually has an installer.
 *
 * The same release carries a checksums.txt (sha256sum layout). Once the installer
 * is picked we read that file and show the matching SHA-256 in the "verify"
 * section, so visitors can check an unsigned build themselves.
 */
(() => {
  // Builds live in their own repository, separate from this site.
  const RELEASES_REPO = "Mix-Studios/client-mix";
  const API = `https://api.github.com/repos/${RELEASES_REPO}`;
  const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases/latest`;
  const CACHE_KEY = "mixclient:latest-release";
  const CACHE_TTL = 10 * 60 * 1000;

  const buttons = [...document.querySelectorAll("[data-download]")];
  const versionChip = document.getElementById("versionChip");

  // Release integrity elements (see the "verify" section in index.html).
  const shaHashEl = document.querySelector("[data-sha-hash]");
  const shaFileEl = document.querySelector("[data-sha-file]");
  const shaCopyEl = document.querySelector("[data-sha-copy]");
  const shaLinkEl = document.querySelector("[data-sha-link]");
  const shaNameEls = [...document.querySelectorAll("[data-sha-name]")];

  // Attachments that hold the hashes rather than a download.
  const CHECKSUM_FILE = /^(checksums?|sha-?256sums?)(\.txt|\.sha256)?$/i;

  const OS = detectOS();
  const OS_LABEL = { windows: "Windows", mac: "macOS", linux: "Linux", other: "your system" };

  const KNOWN_EXTENSIONS = [
    ".exe", ".msi", ".dmg", ".pkg", ".appimage", ".deb", ".rpm", ".tar.gz", ".tgz", ".zip",
  ];

  const OS_EXTENSIONS = {
    windows: [".exe", ".msi"],
    mac: [".dmg", ".pkg"],
    linux: [".appimage", ".deb", ".rpm", ".tar.gz", ".tgz"],
    other: [".exe", ".dmg", ".appimage", ".zip", ".jar"],
  };

  // Attachments nobody wants as the client download.
  const IGNORED = [/\.blockmap$/i, /\.sha\d*$/i, /\.sig$/i, /\.json$/i, /\.ya?ml$/i, /\.txt$/i];

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
    const lower = name.toLowerCase();
    const multi = [".tar.gz", ".tar.xz"].find((ext) => lower.endsWith(ext));
    return multi || KNOWN_EXTENSIONS.find((ext) => lower.endsWith(ext)) || "";
  }

  function scoreAsset(asset) {
    const name = asset.name.toLowerCase();
    const ext = assetExtension(asset.name);
    let score = 0;

    if (OS_EXTENSIONS[OS].includes(ext)) score += 10;
    else if (KNOWN_EXTENSIONS.includes(ext)) score += 1;
    else return -1;

    if (/install|setup/.test(name)) score += 5;
    if (/win|windows/.test(name) && OS === "windows") score += 2;
    if (/mac|osx|darwin/.test(name) && OS === "mac") score += 2;
    if (/linux/.test(name) && OS === "linux") score += 2;
    if (/source|src|debug|symbols/.test(name)) score -= 5;
    return score;
  }

  function pickAsset(assets) {
    const ranked = (assets || [])
      .filter((a) => a && a.name && a.browser_download_url)
      .filter((a) => !IGNORED.some((re) => re.test(a.name)))
      .map((a) => ({ asset: a, score: scoreAsset(a) }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score);

    return ranked.length ? ranked[0].asset : null;
  }

  function newestUsableRelease(list) {
    for (const release of list || []) {
      if (!release || release.draft) continue;
      if (pickAsset(release.assets)) return release;
    }
    return null;
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

    if (!checksums) {
      setChecksumMissing("This release has no checksums.txt yet.");
      return;
    }

    try {
      const res = await fetch(checksums.browser_download_url, { cache: "no-store" });
      if (!res.ok) throw new Error(`checksums.txt: HTTP ${res.status}`);

      const hash = parseChecksum(await res.text(), asset.name);
      if (!hash) throw new Error("installer missing from checksums.txt");

      delete shaHashEl.dataset.state;
      shaHashEl.textContent = hash;
      shaHashEl.dataset.hash = hash;
      if (shaCopyEl) shaCopyEl.hidden = false;
    } catch (err) {
      setChecksumMissing("Couldn't read checksums.txt — open it on the release page.");
    }
  }

  function setButtons(url, { state, label, meta } = {}) {
    buttons.forEach((el) => {
      el.href = url;
      if (state) el.dataset.state = state;
      else el.removeAttribute("data-state");

      const labelEl = el.querySelector("[data-label]");
      const metaEl = el.querySelector("[data-meta]");
      if (labelEl && label) labelEl.textContent = label;
      if (metaEl && meta) metaEl.textContent = meta;
      if (!metaEl && meta) el.title = meta;
      if (url) el.dataset.asset = state === "empty" ? "" : url;
    });
  }

  function applyRelease(release) {
    const asset = pickAsset(release.assets);
    const version = release.tag_name || release.name || "latest";

    if (!asset) {
      setButtons(RELEASES_URL, {
        state: "empty",
        label: "NO BUILDS YET",
        meta: `Release ${version} has no installer yet`,
      });
      loadChecksum(release, null);
      return;
    }

    const platform = OS_LABEL[OS] === "your system" ? "CLIENT" : OS_LABEL[OS].toUpperCase();
    const meta = [version, formatSize(asset.size), asset.name].filter(Boolean).join(" · ");
    setButtons(asset.browser_download_url, { label: `DOWNLOAD FOR ${platform}`, meta });

    if (versionChip) {
      versionChip.hidden = false;
      versionChip.textContent = version;
      versionChip.title = `Latest release: ${version}`;
    }

    loadChecksum(release, asset);
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

  async function load() {
    const cached = readCache();
    if (cached) {
      applyRelease(cached);
      return;
    }

    try {
      const release = await resolveRelease();

      if (release === null) {
        setButtons(RELEASES_URL, {
          state: "empty",
          label: "NO BUILDS YET",
          meta: "The first release appears here automatically",
        });
        return;
      }
      if (release === undefined) throw new Error("GitHub API unavailable");

      writeCache(release);
      applyRelease(release);
    } catch (err) {
      setButtons(RELEASES_URL, {
        state: "empty",
        label: "OPEN LATEST RELEASE",
        meta: "Couldn't reach GitHub — try again in a moment",
      });
    }
  }

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

  // A resolved asset URL starts the download immediately.
  buttons.forEach((el) => {
    el.addEventListener("click", (event) => {
      const url = el.dataset.asset;
      if (!url) return;
      event.preventDefault();
      window.location.href = url;
    });
  });

  load();
})();
