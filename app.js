/*
 * Direct download from the latest GitHub release.
 *
 * On load, ask the GitHub API for the newest release of Mix-Client, choose the
 * installer that matches the visitor's OS and point the download buttons at that
 * asset's URL. Clicking the button then downloads the installer straight away —
 * the visitor never lands on the releases page.
 *
 * Once a new release is published, the site picks it up without a rebuild.
 */
(() => {
  // Builds are published in their own repository, separate from this site.
  // Change this one line if the releases repo ever moves.
  const RELEASES_REPO = "Mix-Studios/client-mix";

  const API_URL = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`;
  const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases/latest`;
  const CACHE_KEY = "mixclient:latest-release";
  const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

  const buttons = [
    {
      el: document.getElementById("downloadBtn"),
      label: document.getElementById("downloadLabel"),
      meta: document.getElementById("downloadMeta"),
    },
    {
      el: document.getElementById("ctaDownload"),
      label: document.getElementById("ctaLabel"),
      meta: document.getElementById("ctaMeta"),
    },
  ].filter((b) => b.el);

  const OS = detectOS();
  const OS_LABEL = { windows: "Windows", mac: "macOS", linux: "Linux", other: "your system" };

  function detectOS() {
    const nav = typeof navigator !== "undefined" ? navigator : {};
    const raw = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || nav.userAgent || "";
    const p = String(raw).toLowerCase();
    if (/win/.test(p)) return "windows";
    if (/mac|iphone|ipad/.test(p)) return "mac";
    if (/linux|x11|android/.test(p)) return "linux";
    return "other";
  }

  const KNOWN_EXTENSIONS = [
    ".exe", ".msi", ".dmg", ".pkg", ".appimage", ".deb", ".rpm", ".tar.gz", ".tgz", ".zip",
  ];

  const OS_EXTENSIONS = {
    windows: [".exe", ".msi"],
    mac: [".dmg", ".pkg"],
    linux: [".appimage", ".deb", ".rpm", ".tar.gz", ".tgz"],
    other: [".exe", ".dmg", ".appimage", ".zip", ".jar"],
  };

  // Files GitHub attaches that nobody wants to download as the client.
  const IGNORED = [/\.blockmap$/i, /\.sha\d*$/i, /\.sig$/i, /\.json$/i, /\.yml$/i, /\.txt$/i];

  function assetExtension(name) {
    const lower = name.toLowerCase();
    const multi = [".tar.gz", ".tar.xz"].find((ext) => lower.endsWith(ext));
    return multi || (KNOWN_EXTENSIONS.find((ext) => lower.endsWith(ext)) || "");
  }

  function scoreAsset(asset) {
    const name = asset.name.toLowerCase();
    const ext = assetExtension(asset.name);
    let score = 0;

    if (OS_EXTENSIONS[OS].includes(ext)) score += 10;
    else if (KNOWN_EXTENSIONS.includes(ext)) score += 1;
    else return -1;

    if (/install|setup/.test(name)) score += 5;
    if (/win|windows/.test(name)) score += OS === "windows" ? 2 : 0;
    if (/mac|osx|darwin/.test(name)) score += OS === "mac" ? 2 : 0;
    if (/linux/.test(name)) score += OS === "linux" ? 2 : 0;
    if (/source|src|debug|symbols/.test(name)) score -= 5;
    return score;
  }

  function pickAsset(assets) {
    const candidates = (assets || [])
      .filter((a) => a && a.name && a.browser_download_url)
      .filter((a) => !IGNORED.some((re) => re.test(a.name)))
      .map((a) => ({ asset: a, score: scoreAsset(a) }))
      .filter((c) => c.score >= 0)
      .sort((a, b) => b.score - a.score);

    return candidates.length ? candidates[0].asset : null;
  }

  function formatSize(bytes) {
    if (!bytes || bytes < 0) return "";
    const mb = bytes / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }

  function renderDownload(url, label, meta) {
    buttons.forEach(({ el, label: labelEl, meta: metaEl }) => {
      el.href = url;
      el.removeAttribute("data-state");
      el.title = meta;
      if (labelEl) labelEl.textContent = label;
      if (metaEl) metaEl.textContent = meta;
    });
  }

  function renderEmpty(label, meta) {
    buttons.forEach(({ el, label: labelEl, meta: metaEl }) => {
      el.href = RELEASES_URL;
      el.dataset.state = "empty";
      el.title = "No release build has been published yet";
      if (labelEl) labelEl.textContent = label;
      if (metaEl) metaEl.textContent = meta;
    });
  }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || Date.now() - parsed.at > CACHE_TTL) return null;
      return parsed.data;
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

  function applyRelease(release) {
    const asset = pickAsset(release.assets);
    const version = release.tag_name || release.name || "latest";

    if (!asset) {
      renderEmpty("No installer in the latest release", `Release ${version} has no downloadable build yet`);
      return;
    }

    const size = formatSize(asset.size);
    const platformLabel = OS_LABEL[OS] === "your system" ? "Mix Client" : `for ${OS_LABEL[OS]}`;
    const metaParts = [version, size, asset.name].filter(Boolean);

    renderDownload(asset.browser_download_url, `Download ${platformLabel}`, metaParts.join(" · "));

    // Keep the click from ever bubbling into a navigation to the release page.
    buttons.forEach(({ el }) => {
      el.dataset.asset = asset.browser_download_url;
    });
  }

  async function loadLatestRelease() {
    const cached = readCache();
    if (cached) {
      applyRelease(cached);
      return;
    }

    try {
      const res = await fetch(API_URL, {
        headers: { Accept: "application/vnd.github+json" },
      });

      if (res.status === 404) {
        renderEmpty("No builds yet", "The first release will show up here automatically");
        return;
      }

      if (!res.ok) throw new Error(`GitHub API responded ${res.status}`);

      const release = await res.json();
      writeCache(release);
      applyRelease(release);
    } catch (err) {
      // Offline, rate-limited or blocked: keep the button usable without
      // promising an asset we could not resolve.
      renderEmpty("Open latest release", "Could not reach GitHub just now — retry in a moment");
    }
  }

  // If a resolved asset URL is known, make the click start the download directly.
  buttons.forEach(({ el }) => {
    el.addEventListener("click", (event) => {
      const url = el.dataset.asset;
      if (!url) return; // let the fallback href work
      event.preventDefault();
      window.location.href = url;
    });
  });

  loadLatestRelease();
})();
