async function loadData() {
  const res = await fetch("data.json", { cache: "no-store" });
  return res.json();
}

const VAPID_PUBLIC_KEY = ""; // Generate with `npx web-push generate-vapid-keys` — see NOTIFICATIONS_SETUP.md

let cachedData = null;

function getView() {
  return localStorage.getItem("trackerView") === "arena" ? "arena" : "benchmarks";
}

function setView(v) {
  localStorage.setItem("trackerView", v);
}

function compositeScore(scores) {
  const values = Object.values(scores).filter((v) => typeof v === "number");
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function rank(companies) {
  return [...companies].sort((a, b) => {
    const ca = compositeScore(a.scores);
    const cb = compositeScore(b.scores);
    if (ca === null && cb === null) return 0;
    if (ca === null) return 1;
    if (cb === null) return -1;
    return cb - ca;
  });
}

function renderUpdated(lastUpdated) {
  const el = document.getElementById("updated");
  if (!lastUpdated) {
    el.textContent = "No data yet — run the agi-tracker-updater subagent.";
    el.classList.add("stale");
    return;
  }
  const updated = new Date(lastUpdated);
  const days = Math.floor((Date.now() - updated.getTime()) / 86400000);
  const stale = days > 14;
  el.textContent = `Last updated ${updated.toISOString().slice(0, 10)} (${days}d ago)`;
  el.classList.toggle("stale", stale);
}

function escapeAttr(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function benchHTML(bench, score) {
  const has = typeof score === "number";
  const valueClass = has ? "bench-value" : "bench-value missing";
  const valueText = has ? score.toFixed(1) : "—";
  const fillWidth = has ? Math.max(0, Math.min(100, score)) : 0;
  const tip = escapeAttr(bench.description || "");
  const dataScore = has ? `data-score="${score}"` : `data-score=""`;
  return `
    <div class="bench" data-tip="${tip}" ${dataScore}>
      <div class="bench-label">
        <span>${bench.label}</span>
        <span class="${valueClass}">${valueText}</span>
      </div>
      <div class="bar"><div class="bar-fill" style="width: ${fillWidth}%"></div></div>
    </div>
  `;
}

function rowHTML(company, benchmarks, position) {
  const composite = compositeScore(company.scores);
  const compositeText =
    composite === null
      ? `<span class="composite empty">no data</span>`
      : `<span class="composite">${composite.toFixed(1)}</span>`;
  const modelText = company.model
    ? `<span class="model">${company.model}</span>`
    : `<span class="model">model TBD</span>`;
  const benches = benchmarks.map((b) => benchHTML(b, company.scores[b.id])).join("");
  const topClass = position === 1 && composite !== null ? "row top-1" : "row";

  return `
    <article class="${topClass}">
      <div class="row-head">
        <div class="rank-name">
          <span class="rank">#${position}</span>
          <span class="company">${company.name}</span>
          ${modelText}
        </div>
        ${compositeText}
      </div>
      <div class="benchmarks">${benches}</div>
    </article>
  `;
}

function renderLeaderboard(data) {
  const view = getView();
  updateViewSwitcher(view);
  if (view === "arena") {
    renderLeaderboardArena(data);
  } else {
    renderLeaderboardBenchmarks(data);
  }
}

function renderLeaderboardBenchmarks(data) {
  const container = document.getElementById("leaderboard");
  const ranked = rank(data.companies);
  const anyData = ranked.some((c) => compositeScore(c.scores) !== null);

  if (!anyData) {
    container.innerHTML = `
      <div class="empty-state">
        <p><strong>No benchmark data yet.</strong></p>
        <p>Run the <code>agi-tracker-updater</code> subagent to populate scores.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = ranked
    .map((c, i) => rowHTML(c, data.benchmarks, i + 1))
    .join("");
}

function topArenaModel(company) {
  const models = company.arenaModels;
  if (!Array.isArray(models) || models.length === 0) return null;
  return [...models].sort((a, b) => b.elo - a.elo)[0];
}

function rankArena(companies) {
  return [...companies].sort((a, b) => {
    const aTop = topArenaModel(a);
    const bTop = topArenaModel(b);
    if (!aTop && !bTop) return 0;
    if (!aTop) return 1;
    if (!bTop) return -1;
    return bTop.elo - aTop.elo;
  });
}

function arenaRowHTML(company, position) {
  const models = Array.isArray(company.arenaModels) ? company.arenaModels : [];
  const topModel = topArenaModel(company);

  if (!topModel) {
    return `
      <article class="row arena">
        <div class="row-head">
          <div class="rank-name">
            <span class="rank">#${position}</span>
            <span class="company">${escapeAttr(company.name)}</span>
          </div>
          <span class="arena-no-data">no Arena entries</span>
        </div>
      </article>
    `;
  }

  const topClass = position === 1 ? "row arena top-1" : "row arena";
  const modelItems = models
    .map(
      (m) => `
        <div class="arena-model-item">
          <span class="arena-model-rank">#${m.rank}</span>
          <span class="arena-model-name">${escapeAttr(m.name)}</span>
          <span class="arena-model-elo">${m.elo}</span>
          <span class="arena-model-margin">±${m.margin}</span>
        </div>
      `
    )
    .join("");

  const expandBtn =
    models.length > 1
      ? `<button class="arena-expand-btn" type="button" data-toggle-list>+ Show all ${models.length} models</button>`
      : "";

  return `
    <article class="${topClass}">
      <div class="row-head">
        <div class="rank-name">
          <span class="rank">#${position}</span>
          <span class="company">${escapeAttr(company.name)}</span>
          <span class="arena-rank-badge">arena #${topModel.rank}</span>
        </div>
        <span class="arena-elo">${topModel.elo}<span class="arena-margin">±${topModel.margin}</span></span>
      </div>
      <div class="arena-headline">
        <span class="arena-top-model">${escapeAttr(topModel.name)}</span>
      </div>
      ${expandBtn}
      <div class="arena-model-list">${modelItems}</div>
    </article>
  `;
}

function renderLeaderboardArena(data) {
  const container = document.getElementById("leaderboard");
  const ranked = rankArena(data.companies);
  const anyData = ranked.some((c) => topArenaModel(c) !== null);

  if (!anyData) {
    container.innerHTML = `
      <div class="empty-state">
        <p><strong>No Arena data yet.</strong></p>
        <p>Run the updater to populate <code>arenaModels</code> for each company.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = ranked.map((c, i) => arenaRowHTML(c, i + 1)).join("");
}

function updateViewSwitcher(view) {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.setAttribute(
      "aria-selected",
      btn.dataset.view === view ? "true" : "false"
    );
  });
}

function setupViewSwitcher() {
  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setView(btn.dataset.view);
      if (cachedData) renderLeaderboard(cachedData);
    });
  });

  document.getElementById("leaderboard").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-toggle-list]");
    if (!btn) return;
    const row = btn.closest(".row");
    row.classList.toggle("expanded");
    const expanded = row.classList.contains("expanded");
    const count = row.querySelectorAll(".arena-model-item").length;
    btn.textContent = expanded
      ? `− Hide ${count} models`
      : `+ Show all ${count} models`;
  });
}

async function refresh() {
  const btn = document.getElementById("refresh");
  if (btn) {
    btn.disabled = true;
    btn.classList.add("spinning");
  }
  try {
    const data = await loadData();
    cachedData = data;
    renderUpdated(data.lastUpdated);
    renderDoomMeter(data.doomMeter);
    renderLeaderboard(data);
    renderArticles(data.articles);
  } catch (err) {
    document.getElementById("leaderboard").innerHTML = `
      <div class="empty-state">
        <p>Failed to load <code>data.json</code>.</p>
        <p>${err.message}</p>
      </div>
    `;
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.disabled = false;
        btn.classList.remove("spinning");
      }, 300);
    }
  }
}

function renderDoomMeter(meter) {
  const el = document.getElementById("doom-meter");
  if (!el) return;
  if (!meter || !Array.isArray(meter.experts) || meter.experts.length === 0) {
    el.innerHTML = "";
    return;
  }
  const valid = meter.experts.filter((e) => typeof e.pDoom === "number");
  const mean = valid.reduce((a, b) => a + b.pDoom, 0) / valid.length;
  const pct = Math.max(0, Math.min(100, mean));

  const listItems = valid
    .slice()
    .sort((a, b) => b.pDoom - a.pDoom)
    .map(
      (e) => `
        <li>
          <span class="tip-name">${escapeAttr(e.name)}</span>
          <span class="tip-val">${e.pDoom}%</span>
        </li>
      `
    )
    .join("");

  const tipHtml = `
    <div class="tip-title">${escapeAttr(meter.label)} — mean of ${valid.length}</div>
    <ul class="tip-list">${listItems}</ul>
    <span class="tip-note">${escapeAttr(meter.methodology)}</span>
  `;

  el.dataset.tipHtml = tipHtml;
  el.innerHTML = `
    <div class="doom-ring">
      <svg class="doom-svg" viewBox="0 0 36 36" aria-hidden="true">
        <defs>
          <linearGradient id="doom-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#7c5cff" />
            <stop offset="100%" stop-color="#22d3ee" />
          </linearGradient>
        </defs>
        <circle class="doom-bg" cx="18" cy="18" r="15.9" pathLength="100" />
        <circle class="doom-fill" cx="18" cy="18" r="15.9" pathLength="100"
          stroke-dasharray="${pct.toFixed(1)} 100" />
      </svg>
      <span class="doom-value">${Math.round(pct)}%</span>
    </div>
    <div class="doom-label">${escapeAttr(meter.label)}</div>
  `;
}

function renderArticles(articles) {
  const track = document.getElementById("articles-track");
  if (!track) return;
  if (!Array.isArray(articles) || articles.length === 0) {
    track.innerHTML = `<div class="empty-state" style="flex:1;">No articles yet — add some to <code>data.json</code>.</div>`;
    return;
  }
  track.innerHTML = articles
    .map(
      (a) => `
        <a class="article-card" href="${escapeAttr(a.url)}" target="_blank" rel="noopener noreferrer">
          <div class="article-source">${escapeAttr(a.source)}</div>
          <div class="article-title">${escapeAttr(a.title)}</div>
          <div class="article-summary">${escapeAttr(a.summary)}</div>
        </a>
      `
    )
    .join("");
}

async function typewriter(el, full, msPerChar, abortCheck) {
  for (let i = 0; i < full.length; i++) {
    if (abortCheck && abortCheck()) return;
    el.textContent = full.slice(0, i + 1);
    const ch = full[i];
    const delay = /[.!?]/.test(ch)
      ? msPerChar * 7
      : /[,;:]/.test(ch)
      ? msPerChar * 3
      : msPerChar;
    await new Promise((r) => setTimeout(r, delay));
  }
}

function setupParallax() {
  const layer = document.querySelector(".parallax-bg");
  if (!layer) return;
  let scheduled = false;
  const update = () => {
    scheduled = false;
    layer.style.transform = `translate3d(0, ${-window.scrollY * 0.5}px, 0)`;
  };
  window.addEventListener(
    "scroll",
    () => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(update);
      }
    },
    { passive: true }
  );
  update();
}

function setupOverview() {
  const cta = document.getElementById("just-tell-me");
  const panel = document.getElementById("overview-panel");
  const text = document.getElementById("overview-text");
  const close = document.getElementById("overview-close");
  if (!cta || !panel || !text || !close) return;

  let runId = 0;

  cta.addEventListener("click", async () => {
    if (!panel.hasAttribute("hidden")) {
      panel.setAttribute("hidden", "");
      return;
    }
    const myRun = ++runId;
    panel.removeAttribute("hidden");
    text.classList.remove("typing");
    text.classList.add("loading");
    text.textContent = "Generating";
    try {
      const data = await loadData();
      const overview =
        data?.articlesOverview ||
        "No overview available — add an `articlesOverview` field to data.json.";
      await new Promise((r) => setTimeout(r, 450));
      if (myRun !== runId || panel.hasAttribute("hidden")) return;
      text.classList.remove("loading");
      text.classList.add("typing");
      text.textContent = "";
      await typewriter(text, overview, 14, () => myRun !== runId || panel.hasAttribute("hidden"));
      if (myRun === runId) text.classList.remove("typing");
    } catch (err) {
      text.classList.remove("loading", "typing");
      text.textContent = `Failed to load overview: ${err.message}`;
    }
  });

  close.addEventListener("click", () => {
    runId++;
    panel.setAttribute("hidden", "");
  });
}

function setupCarousel() {
  const track = document.getElementById("articles-track");
  const prev = document.querySelector(".carousel-prev");
  const next = document.querySelector(".carousel-next");
  if (!track || !prev || !next) return;
  const step = () => Math.max(280, Math.floor(track.clientWidth * 0.9));
  prev.addEventListener("click", () => track.scrollBy({ left: -step(), behavior: "smooth" }));
  next.addEventListener("click", () => track.scrollBy({ left: step(), behavior: "smooth" }));
}

function setupTooltip() {
  const tooltip = document.createElement("div");
  tooltip.className = "cursor-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  document.body.appendChild(tooltip);

  let active = null;

  document.addEventListener("mouseover", (e) => {
    const target = e.target.closest("[data-tip], [data-tip-html]");
    if (!target || target === active) return;
    active = target;
    const html = target.dataset.tipHtml;
    if (html) {
      tooltip.innerHTML = html;
      tooltip.classList.add("rich");
    } else {
      tooltip.textContent = target.dataset.tip || "";
      tooltip.classList.remove("rich");
    }
    tooltip.classList.add("visible");
    tooltip.setAttribute("aria-hidden", "false");
  });

  document.addEventListener("mousemove", (e) => {
    if (!active) return;
    const pad = 14;
    const r = tooltip.getBoundingClientRect();
    let x = e.clientX + pad;
    let y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tooltip.style.transform = `translate(${x}px, ${y}px)`;
  });

  document.addEventListener("mouseout", (e) => {
    if (!active) return;
    if (e.relatedTarget && active.contains(e.relatedTarget)) return;
    active = null;
    tooltip.classList.remove("visible");
    tooltip.setAttribute("aria-hidden", "true");
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return new Uint8Array([...raw].map((c) => c.charCodeAt(0)));
}

function showSubscriptionModal(subJSON) {
  const modal = document.createElement("div");
  modal.className = "subscription-modal";
  modal.innerHTML = `
    <div class="subscription-modal-content">
      <h3>One-time setup</h3>
      <p>Copy this JSON and add it as a GitHub repo secret named <code>PUSH_SUBSCRIPTION</code> at github.com/&lt;you&gt;/&lt;repo&gt;/settings/secrets/actions.</p>
      <textarea readonly>${subJSON}</textarea>
      <div class="subscription-modal-actions">
        <button type="button" data-action="copy">Copy</button>
        <button type="button" data-action="close" class="primary">Done</button>
      </div>
    </div>
  `;
  modal.addEventListener("click", async (e) => {
    if (e.target === modal || e.target.dataset.action === "close") {
      modal.remove();
      return;
    }
    if (e.target.dataset.action === "copy") {
      await navigator.clipboard.writeText(subJSON);
      e.target.textContent = "Copied";
      setTimeout(() => (e.target.textContent = "Copy"), 1500);
    }
  });
  document.body.appendChild(modal);
}

async function setupNotifications() {
  const btn = document.getElementById("notifications");
  if (!btn) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;

  btn.hidden = false;
  let registration;
  try {
    registration = await navigator.serviceWorker.register("sw.js");
  } catch (err) {
    console.error("Service worker registration failed:", err);
    btn.hidden = true;
    return;
  }

  const sync = async () => {
    const sub = await registration.pushManager.getSubscription();
    btn.classList.toggle("subscribed", !!sub);
    btn.querySelector(".notif-label").textContent = sub ? "Subscribed" : "Notify me";
  };
  await sync();

  btn.addEventListener("click", async () => {
    if (!VAPID_PUBLIC_KEY) {
      alert(
        "Notifications not configured yet. See NOTIFICATIONS_SETUP.md — you need to generate VAPID keys and set VAPID_PUBLIC_KEY in app.js."
      );
      return;
    }
    const current = await registration.pushManager.getSubscription();
    if (current) {
      await current.unsubscribe();
      await sync();
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    try {
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      await sync();
      showSubscriptionModal(JSON.stringify(sub.toJSON(), null, 2));
    } catch (err) {
      console.error("Subscription failed:", err);
      alert("Subscription failed: " + err.message);
    }
  });
}

document.getElementById("refresh")?.addEventListener("click", refresh);
setupParallax();
setupTooltip();
setupCarousel();
setupOverview();
setupViewSwitcher();
setupNotifications();
refresh();
