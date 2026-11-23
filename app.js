/*
 * Play screen: the newest published release, turned into one download button and
 * a card per platform file.
 *
 * All release/asset knowledge lives in release.js, which download.html loads
 * too, so the two pages cannot disagree about which file belongs to a platform
 * or which hash belongs to a file.
 *
 * The page keeps itself current: release metadata is re-read every few minutes
 * and whenever the tab comes back, so publishing a release updates the site
 * without anyone pressing Refresh or reloading.
 */
(() => {
  const R = window.MixRelease;
  if (!R) return;

  const {
    RELEASES_REPO,
    RELEASES_URL,
    CACHE_KEY,
    TARGETS,
    detectOS,
    assetExtension,
    escapeHtml,
    buildKind,
    versionOf,
    picksFor,
    primaryPick,
    formatSize,
    findChecksumAsset,
    digestOf,
    parseChecksum,
    readCache,
    writeCache,
    resolveRelease,
  } = R;

  const DOWNLOAD_PAGE = "download.html";
  const AUTO_REFRESH_MS = 5 * 60 * 1000;       // the page polls on its own
  const VISIBILITY_MIN_MS = 60 * 1000;         // returning to the tab refreshes if stale

  const buttons = [...document.querySelectorAll("[data-download]")];
  const versionChip = document.getElementById("versionChip");
  const titlebarTitleEl = document.querySelector("[data-titlebar-title]");
  const sidebarVersionEl = document.querySelector("[data-sidebar-version]");
  const kindEls = [...document.querySelectorAll("[data-build-kind]")];
  const platformsEl = document.querySelector("[data-platforms]");
  const macChoiceEl = document.querySelector("[data-mac-choice]");
  const macButtonsEl = document.querySelector("[data-mac-buttons]");

  // Apple silicon and Intel ship as separate disk images, so Macs get to say
  // which one they are instead of the page guessing.
  const ARCH_LABELS = { "mac-arm": "APPLE SILICON", "mac-intel": "INTEL" };

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

  const state = { release: null, picks: [], primary: null, macPick: null };
  let lastApplied = 0;
  let inFlight = null;

  const OS = detectOS();

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

  // The window chrome names the same release the chip does, so nothing on the
  // page has to be edited when a new version is published.
  function setChromeVersion(version) {
    const bare = version ? String(version).replace(/^v/i, "") : "";
    if (titlebarTitleEl) {
      titlebarTitleEl.textContent = bare ? `MixClient ${bare}` : "MixClient";
    }
    if (sidebarVersionEl) {
      const tag = version ? String(version) : "";
      // "v1.2.3" stays as-is, "1.2.3" gains the v, a named tag like "Test" keeps its name.
      sidebarVersionEl.textContent = /^v/i.test(tag) ? tag : (/^\d/.test(tag) ? `v${tag}` : tag);
    }
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

  function showHash(hash) {
    if (!shaHashEl) return;
    delete shaHashEl.dataset.state;
    shaHashEl.textContent = hash;
    shaHashEl.dataset.hash = hash;
    if (shaCopyEl) shaCopyEl.hidden = false;
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
    // Two Mac files share a name, so the button says which architecture it is.
    if (target.id === "mac-arm" || target.id === "mac-intel") return `DOWNLOAD FOR ${target.label}`;
    return `DOWNLOAD FOR ${target.short || target.label}`;
  }

  // One chosen file drives the big button, the highlighted card and the hash.
  function selectPrimary(pick) {
    if (!pick) return;
    state.primary = pick;

    const { target, asset } = pick;
    const version = versionOf(state.release);
    const size = formatSize(asset.size);

    const kind = state.release ? buildKind(state.release) : null;
    setBuild(`MixClient ${version}`, `${asset.name}${size ? ` · ${size}` : ""} · unsigned`);
    setStatus(kind && kind.id === "test"
      ? `Test build · ${target.short || target.label} · checked ${clock()}`
      : `Ready · ${target.short || target.label} build · checked ${clock()}`);
    setButtons(asset.browser_download_url, {
      label: buttonLabel(target),
      meta: [version, size, asset.name].filter(Boolean).join(" · "),
    });

    if (platformsEl) {
      platformsEl.querySelectorAll("[data-target]").forEach((card) => {
        card.classList.toggle("is-current", card.dataset.target === target.id);
      });
    }

    if (macButtonsEl) {
      macButtonsEl.querySelectorAll("[data-arch]").forEach((btn) => {
        const on = btn.dataset.arch === target.id;
        btn.classList.toggle("is-current", on);
        btn.setAttribute("aria-pressed", String(on));
      });
    }

    loadChecksum(state.release, asset);
  }

  function renderMacChoice() {
    if (!macChoiceEl || !macButtonsEl) return;

    const macPicks = state.picks.filter(
      (entry) => entry.target.id === "mac-arm" || entry.target.id === "mac-intel",
    );

    if (OS !== "mac" || macPicks.length < 2) {
      macChoiceEl.hidden = true;
      macButtonsEl.textContent = "";
      return;
    }

    macChoiceEl.hidden = false;
    macButtonsEl.textContent = "";

    macPicks.forEach(({ target, asset }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn";
      btn.dataset.arch = target.id;
      btn.title = asset.name;
      btn.textContent = `${ARCH_LABELS[target.id]} · ${formatSize(asset.size) || "size unknown"}`;

      const on = Boolean(state.primary && state.primary.target.id === target.id);
      btn.classList.toggle("is-current", on);
      btn.setAttribute("aria-pressed", String(on));

      btn.addEventListener("click", () => {
        state.macPick = target.id;
        selectPrimary({ target, asset });
        renderMacChoice();
      });

      macButtonsEl.appendChild(btn);
    });
  }

  function applyRelease(release) {
    state.release = release;
    lastApplied = Date.now();

    const version = versionOf(release);
    const kind = buildKind(release);
    const picks = picksFor(release);
    state.picks = picks;
    setKind(kind);
    setChromeVersion(version);

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
      renderMacChoice();
      loadChecksum(release, null);
      return;
    }

    const primary = primaryPick(picks, OS, state.macPick);
    renderPlatforms(picks, primary ? primary.target.id : null);
    selectPrimary(primary);
    renderMacChoice();

    if (versionChip) {
      versionChip.hidden = false;
      versionChip.textContent = version;
      versionChip.title = `Latest release: ${version} (${kind.label.toLowerCase()})`;
    }
  }

  function applyEmpty() {
    state.release = null;
    state.picks = [];
    state.primary = null;
    setKind(null);
    setChromeVersion(null);
    setButtons(DOWNLOAD_PAGE, {
      state: "empty",
      label: "NO BUILDS YET",
      meta: "The first release appears here automatically",
    });
    setBuild("No build published yet", "The first release appears here automatically.");
    setStatus("No release published yet — this page checks again on its own.");
    renderPlatforms([], null);
    renderMacChoice();
  }

  function applyFailure() {
    state.picks = [];
    state.primary = null;
    setKind(null);
    setChromeVersion(null);
    setButtons(DOWNLOAD_PAGE, {
      state: "empty",
      label: "OPEN LATEST RELEASE",
      meta: "Couldn't reach GitHub — trying again shortly",
    });
    setBuild("Couldn't reach GitHub", "The page retries by itself; Refresh checks right now.");
    setStatus("Couldn't reach GitHub — retrying automatically.");
    renderPlatforms([], null);
    renderMacChoice();
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

  // Where the instructions page lives. It resolves the release itself; these
  // params only highlight the file that was just handed to the browser.
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
