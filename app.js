async function loadData() {
  const res = await fetch("data.json", { cache: "no-store" });
  return res.json();
}

const VAPID_PUBLIC_KEY = "BKHNjFNCA0jVJ81opEYBH4ovwIYb3I87QEGzpj2woI7CDsnNyorD9TDKdS8vgziXF2rSV46g3zNfxpO2GDsiSgk";

let cachedData = null;
let cachedLeaderboard = null;

const ARENA_CATEGORIES = [
  {
    id: "overall",
    label: "Overall",
    tip: "War Map across all five categories. Each cell is a lab's rank in that category; Fronts Won counts how many categories they hold #1. Sorted by Fronts Won, then best average rank.",
  },
  {
    id: "conversation",
    label: "The Conversation",
    tip: "Text-chat arena (style-controlled). Models compete on open-ended back-and-forth; ratings come from millions of pairwise human votes on which response was better.",
  },
  {
    id: "codebase",
    label: "The Codebase",
    tip: "Web-dev / code arena. Models build working code from a prompt and humans pick the better implementation.",
  },
  {
    id: "image",
    label: "The Image",
    tip: "Text-to-image arena. Users vote on which generated image better matches the prompt across millions of comparisons.",
  },
  {
    id: "reel",
    label: "The Reel",
    tip: "Text-to-video arena. Models generate short clips from a prompt; humans pick the winner.",
  },
  {
    id: "eye",
    label: "The Eye",
    tip: "Vision / multimodal arena. Models reason about uploaded images alongside text; users pick whose answer was better.",
  },
];

function getView() {
  return localStorage.getItem("trackerView") === "arena" ? "arena" : "benchmarks";
}

function setView(v) {
  localStorage.setItem("trackerView", v);
}

function getArenaSubtab() {
  const stored = localStorage.getItem("arenaSubtab");
  return ARENA_CATEGORIES.some((c) => c.id === stored) ? stored : "overall";
}

function setArenaSubtab(v) {
  localStorage.setItem("arenaSubtab", v);
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

function renderLeaderboard(data, leaderboard) {
  const view = getView();
  updateViewSwitcher(view);
  if (view === "arena") {
    renderLeaderboardArena(leaderboard);
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

function formatRelativeDate(asOf, daysSince) {
  const d = daysSince === 0 ? "today" : daysSince === 1 ? "1 day ago" : `${daysSince} days ago`;
  return `Arena last published: ${asOf} (${d})`;
}

function deltaBadgeHTML(delta) {
  if (delta === null || delta === undefined || delta === 0) {
    return `<span class="arena-delta arena-delta-flat">—</span>`;
  }
  if (delta > 0) {
    return `<span class="arena-delta arena-delta-up">▲${delta}</span>`;
  }
  return `<span class="arena-delta arena-delta-down">▼${Math.abs(delta)}</span>`;
}

function badgeChipsHTML(badges) {
  if (!Array.isArray(badges) || badges.length === 0) return "";
  return badges
    .map((b) => `<span class="arena-lab-badge">${escapeAttr(b)}</span>`)
    .join("");
}

function renderArenaOverall(arena) {
  const labs = arena.overall?.labs || [];
  if (labs.length === 0) {
    return `<div class="empty-state">No labs ranked yet.</div>`;
  }
  const cats = ARENA_CATEGORIES.filter((c) => c.id !== "overall");
  const headerCols = cats
    .map((c) => `<th scope="col" class="arena-warmap-cat">${escapeAttr(c.label)}</th>`)
    .join("");
  const rows = labs
    .map((lab) => {
      const cells = cats
        .map((c) => {
          const rank = lab.ranks_by_category?.[c.id];
          if (!rank) return `<td class="arena-warmap-cell arena-warmap-empty">—</td>`;
          const cls =
            rank === 1
              ? "arena-warmap-cell arena-warmap-first"
              : "arena-warmap-cell";
          return `<td class="${cls}">#${rank}</td>`;
        })
        .join("");
      return `
        <tr>
          <th scope="row" class="arena-warmap-lab">
            <span class="arena-lab-name">${escapeAttr(lab.lab_name)}</span>
            ${badgeChipsHTML(lab.badges)}
          </th>
          ${cells}
          <td class="arena-warmap-fronts">${lab.fronts_won}</td>
        </tr>
      `;
    })
    .join("");
  return `
    <div class="arena-warmap-wrap">
      <table class="arena-warmap">
        <thead>
          <tr>
            <th scope="col" class="arena-warmap-lab-header">Lab</th>
            ${headerCols}
            <th scope="col" class="arena-warmap-fronts-header" title="Categories where this lab holds #1">Fronts Won</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderArenaCategory(arena, categoryId) {
  const cat = arena.categories?.[categoryId];
  const top = cat?.top_labs || [];
  if (top.length === 0) {
    return `<div class="empty-state">No labs ranked in this category yet.</div>`;
  }
  const rows = top
    .map(
      (entry) => `
        <tr>
          <td class="arena-cat-rank">#${entry.rank}</td>
          <td class="arena-cat-lab">${escapeAttr(entry.lab_name)}</td>
          <td class="arena-cat-model">${escapeAttr(entry.top_model)}</td>
          <td class="arena-cat-elo">${entry.elo}</td>
          <td class="arena-cat-delta">${deltaBadgeHTML(entry.delta_7d)}</td>
        </tr>
      `
    )
    .join("");
  const note =
    top.length < 5
      ? `<p class="arena-cat-note">Showing ${top.length} labs — fewer than 5 labs currently ranked in this category.</p>`
      : "";
  return `
    <table class="arena-cat-table">
      <thead>
        <tr>
          <th scope="col">Rank</th>
          <th scope="col">Lab</th>
          <th scope="col">Top model</th>
          <th scope="col">Elo</th>
          <th scope="col" title="Rank change since last snapshot">Δ</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${note}
  `;
}

function renderLeaderboardArena(leaderboard) {
  const container = document.getElementById("leaderboard");
  const arena = leaderboard?.arena_view;
  if (!arena) {
    container.innerHTML = `
      <div class="empty-state">
        <p><strong>Arena data not loaded yet.</strong></p>
        <p>The daily refresh writes <code>data/leaderboard.json</code>. Run <code>node scripts/refresh-arena.mjs</code> locally to seed it.</p>
      </div>
    `;
    return;
  }

  const activeSubtab = getArenaSubtab();
  const subtabs = ARENA_CATEGORIES.map(
    (c) => `
      <button type="button" class="arena-subtab" data-arena-subtab="${escapeAttr(c.id)}"
        data-tip="${escapeAttr(c.tip || "")}"
        aria-selected="${c.id === activeSubtab ? "true" : "false"}">${escapeAttr(c.label)}</button>
    `
  ).join("");

  const content =
    activeSubtab === "overall"
      ? renderArenaOverall(arena)
      : renderArenaCategory(arena, activeSubtab);

  const asOf = formatRelativeDate(arena.as_of, arena.days_since_arena_update);

  container.innerHTML = `
    <div class="arena-container">
      <div class="arena-meta">
        <span class="arena-asof" title="Arena batches updates; the snapshot date reflects when lmarena.ai last published, not when this site fetched.">${escapeAttr(asOf)}</span>
        <span class="arena-source">via <a href="https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset" target="_blank" rel="noopener noreferrer">lmarena-ai/leaderboard-dataset</a></span>
      </div>
      <div class="arena-subtabs" role="tablist" aria-label="Arena category">
        ${subtabs}
      </div>
      <div class="arena-subtab-content">${content}</div>
    </div>
  `;
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
      renderLeaderboard(cachedData, cachedLeaderboard);
    });
  });

  // Event-delegated arena sub-tab click handler.
  document.getElementById("leaderboard").addEventListener("click", (e) => {
    const subtab = e.target.closest("[data-arena-subtab]");
    if (subtab) {
      const id = subtab.dataset.arenaSubtab;
      setArenaSubtab(id);
      renderLeaderboard(cachedData, cachedLeaderboard);
    }
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
    // Arena view reads from a separate file written by the deterministic refresh script.
    // This file may not exist yet on fresh checkouts; fall back to null and show an empty state.
    let leaderboard = null;
    try {
      const lbRes = await fetch("data/leaderboard.json", { cache: "no-store" });
      if (lbRes.ok) leaderboard = await lbRes.json();
    } catch (_) {
      // Network or parse error; arena view will show its empty state.
    }
    cachedLeaderboard = leaderboard;
    renderUpdated(data.lastUpdated);
    renderDoomMeter(data.doomMeter);
    renderPersonalDoom(data.personalDoom);
    renderLeaderboard(data, leaderboard);
    renderArticles(data.articles);
    renderQuiz(data.toolQuiz);
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

  el.removeAttribute("data-tip-html");
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
  `;

  const heading = document.getElementById("doom-heading");
  if (heading && meter.label) heading.textContent = meter.label;

  const chart = document.getElementById("doom-chart");
  if (chart) {
    const sorted = valid.slice().sort((a, b) => b.pDoom - a.pDoom);
    chart.innerHTML = sorted
      .map((e) => {
        const tip = escapeAttr(e.context || "");
        return `
          <div class="expert-row" role="listitem" data-tip="${tip}">
            <span class="expert-name">${escapeAttr(e.name)}</span>
            <div class="expert-bar"><div class="expert-bar-fill" style="width: ${e.pDoom}%"></div></div>
            <span class="expert-value">${e.pDoom}%</span>
          </div>
        `;
      })
      .join("");
  }

  const methodologyEl = document.getElementById("doom-methodology");
  if (methodologyEl) {
    methodologyEl.textContent = meter.methodology || "";
  }
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

function setupPageNav() {
  const navList = document.getElementById("page-nav-list");
  if (!navList) return;
  const items = Array.from(navList.querySelectorAll(".page-nav-item"));
  const sections = items
    .map((item) => ({ item, target: document.getElementById(item.dataset.section) }))
    .filter((s) => s.target);
  if (sections.length === 0) return;

  function update() {
    const focusLine = window.innerHeight * 0.33;
    let activeIdx = 0;
    let bestScore = -Infinity;
    sections.forEach((s, i) => {
      const top = s.target.getBoundingClientRect().top;
      // Section is "active" if its top has been scrolled past the focus line.
      // Among those, the LATEST (top closest to focusLine from above) wins.
      const score = top <= focusLine ? top : -Infinity;
      if (score > bestScore) {
        bestScore = score;
        activeIdx = i;
      }
    });

    items.forEach((item, i) => item.classList.toggle("active", i === activeIdx));

    const activeItem = items[activeIdx];
    const containerHeight = navList.parentElement.offsetHeight;
    const itemCenter = activeItem.offsetTop + activeItem.offsetHeight / 2;
    const shift = containerHeight / 2 - itemCenter;
    navList.style.transform = `translateY(${shift}px)`;
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      update();
    });
  }
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  update();
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

const quizState = {};
let quizWired = false;
let personalDoomWired = false;

function renderPersonalDoom(personal) {
  const questionEl = document.getElementById("personal-doom-question");
  const resultEl = document.getElementById("personal-doom-result");
  const meterEl = document.getElementById("personal-doom-meter");
  const predictionEl = document.getElementById("personal-doom-prediction");
  const methodologyEl = document.getElementById("personal-doom-methodology");
  const headingEl = document.getElementById("personal-doom-heading");
  if (!questionEl) return;
  if (!personal || !personal.question || !Array.isArray(personal.question.options)) {
    questionEl.innerHTML = `<div class="empty-state">Add a <code>personalDoom</code> block to data.json.</div>`;
    return;
  }

  if (headingEl && personal.label) headingEl.textContent = personal.label;
  if (methodologyEl) methodologyEl.textContent = personal.methodology || "";

  questionEl.innerHTML = `
    <span class="quiz-q-label">${escapeAttr(personal.question.label)}</span>
    <div class="quiz-chips" role="radiogroup" aria-label="${escapeAttr(personal.question.label)}">
      ${personal.question.options
        .map(
          (opt) => `
            <button type="button" class="quiz-chip" role="radio"
              aria-pressed="false" data-value="${escapeAttr(opt.value)}">${escapeAttr(opt.label)}</button>
          `
        )
        .join("")}
    </div>
  `;

  if (resultEl) resultEl.hidden = true;
  if (predictionEl) predictionEl.textContent = "";
  if (meterEl) meterEl.innerHTML = "";

  if (personalDoomWired) return;
  personalDoomWired = true;

  questionEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".quiz-chip");
    if (!chip) return;
    const chipsParent = chip.closest(".quiz-chips");
    if (!chipsParent) return;
    chipsParent
      .querySelectorAll(".quiz-chip")
      .forEach((c) => c.setAttribute("aria-pressed", c === chip ? "true" : "false"));
    const value = chip.dataset.value;
    const pick = personal.matrix?.[value];
    if (!pick) return;
    const pct = Math.max(0, Math.min(100, pick.pDoom));
    meterEl.innerHTML = `
      <div class="doom-ring">
        <svg class="doom-svg" viewBox="0 0 36 36" aria-hidden="true">
          <defs>
            <linearGradient id="personal-doom-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="#7c5cff" />
              <stop offset="100%" stop-color="#22d3ee" />
            </linearGradient>
          </defs>
          <circle class="doom-bg" cx="18" cy="18" r="15.9" pathLength="100" />
          <circle class="doom-fill" cx="18" cy="18" r="15.9" pathLength="100"
            style="stroke: url(#personal-doom-grad);"
            stroke-dasharray="${pct.toFixed(1)} 100" />
        </svg>
        <span class="doom-value">${Math.round(pct)}%</span>
      </div>
    `;
    predictionEl.textContent = pick.prediction || "";
    resultEl.hidden = false;
  });
}

function renderQuiz(quiz) {
  const questionsEl = document.getElementById("quiz-questions");
  const resultEl = document.getElementById("quiz-result");
  const resetBtn = document.getElementById("quiz-reset");
  const showAllBtn = document.getElementById("just-show-me");
  const showAllPanel = document.getElementById("quiz-showall-panel");
  const showAllCloseBtn = document.getElementById("quiz-showall-close");
  const showAllGrid = document.getElementById("quiz-showall-grid");
  if (!questionsEl || !resultEl) return;
  if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
    questionsEl.innerHTML = `<div class="empty-state">No quiz configured — add a <code>toolQuiz</code> block to <code>data.json</code>.</div>`;
    return;
  }

  // Reset state on each render
  for (const key of Object.keys(quizState)) delete quizState[key];

  questionsEl.innerHTML = quiz.questions
    .map(
      (q) => `
        <div class="quiz-q" data-qid="${escapeAttr(q.id)}">
          <span class="quiz-q-label">${escapeAttr(q.label)}</span>
          <div class="quiz-chips" role="radiogroup" aria-label="${escapeAttr(q.label)}">
            ${(q.options || [])
              .map(
                (opt) => `
                  <button type="button" class="quiz-chip" role="radio"
                    aria-pressed="false" data-value="${escapeAttr(opt.value)}">${escapeAttr(opt.label)}</button>
                `
              )
              .join("")}
          </div>
        </div>
      `
    )
    .join("");

  resultEl.hidden = true;
  resultEl.innerHTML = "";
  if (resetBtn) resetBtn.hidden = true;
  if (showAllPanel) showAllPanel.hidden = true;
  if (showAllGrid) showAllGrid.innerHTML = "";

  if (quizWired) return;
  quizWired = true;

  questionsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".quiz-chip");
    if (!chip) return;
    const qEl = chip.closest(".quiz-q");
    const qid = qEl?.dataset.qid;
    if (!qid) return;
    qEl
      .querySelectorAll(".quiz-chip")
      .forEach((c) => c.setAttribute("aria-pressed", c === chip ? "true" : "false"));
    quizState[qid] = chip.dataset.value;
    if (resetBtn) resetBtn.hidden = false;
    maybeShowResult(quiz);
  });

  resetBtn?.addEventListener("click", () => {
    for (const key of Object.keys(quizState)) delete quizState[key];
    questionsEl
      .querySelectorAll(".quiz-chip")
      .forEach((c) => c.setAttribute("aria-pressed", "false"));
    resultEl.hidden = true;
    resultEl.innerHTML = "";
    resetBtn.hidden = true;
  });

  showAllBtn?.addEventListener("click", () => {
    if (!showAllPanel) return;
    if (!showAllPanel.hidden) {
      showAllPanel.hidden = true;
      return;
    }
    if (showAllGrid && !showAllGrid.innerHTML) {
      renderShowAll(quiz, showAllGrid);
    }
    showAllPanel.hidden = false;
  });

  showAllCloseBtn?.addEventListener("click", () => {
    if (showAllPanel) showAllPanel.hidden = true;
  });
}

function renderShowAll(quiz, grid) {
  const intentQ = quiz.questions.find((q) => q.id === "intent");
  if (!intentQ) return;
  const intentLabels = {};
  const intentOrder = [];
  for (const opt of intentQ.options || []) {
    intentLabels[opt.value] = opt.label;
    intentOrder.push(opt.value);
  }
  const byIntent = {};
  for (const [key, pick] of Object.entries(quiz.matrix || {})) {
    const [intent] = key.split("|");
    if (!byIntent[intent]) byIntent[intent] = new Map();
    if (!byIntent[intent].has(pick.name)) {
      byIntent[intent].set(pick.name, pick);
    }
  }
  grid.innerHTML = intentOrder
    .map((intent) => {
      const tools = byIntent[intent] ? Array.from(byIntent[intent].values()) : [];
      const items = tools
        .map(
          (t) => `
            <li class="usecase-tool">
              <a class="usecase-tool-name" href="${escapeAttr(t.url)}" target="_blank" rel="noopener noreferrer">${escapeAttr(t.name)}</a>
              <span class="usecase-tool-why">${escapeAttr(t.why || "")}</span>
            </li>
          `
        )
        .join("");
      return `
        <article class="usecase-card">
          <div class="usecase-head">
            <span class="usecase-name">${escapeAttr(intentLabels[intent] || intent)}</span>
          </div>
          <ul class="usecase-tools">${items}</ul>
        </article>
      `;
    })
    .join("");
}

function maybeShowResult(quiz) {
  const resultEl = document.getElementById("quiz-result");
  if (!resultEl) return;
  const requiredIds = quiz.questions.map((q) => q.id);
  const allAnswered = requiredIds.every((id) => quizState[id]);
  if (!allAnswered) {
    resultEl.hidden = true;
    return;
  }
  const key = requiredIds.map((id) => quizState[id]).join("|");
  const pick = quiz.matrix?.[key];
  if (!pick) {
    resultEl.hidden = false;
    resultEl.innerHTML = `
      <div class="quiz-result-card">
        <span class="quiz-result-label">No pick for that combo</span>
        <div class="quiz-result-why">Honest answer: I don't have a confident recommendation for this combination yet.</div>
      </div>
    `;
    return;
  }
  resultEl.hidden = false;
  resultEl.innerHTML = `
    <div class="quiz-result-card">
      <span class="quiz-result-label">My pick</span>
      <div class="quiz-result-name">${escapeAttr(pick.name)}</div>
      <div class="quiz-result-why">${escapeAttr(pick.why || "")}</div>
      <a class="quiz-result-cta" href="${escapeAttr(pick.url)}" target="_blank" rel="noopener noreferrer">Try it →</a>
    </div>
  `;
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

const NOTIF_DB = "agi-tracker-notifications";
const NOTIF_STORE = "items";
const NOTIF_CHANNEL = "agi-tracker-notifications";

function openNotifDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOTIF_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(NOTIF_STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllNotifications() {
  const db = await openNotifDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(NOTIF_STORE, "readonly").objectStore(NOTIF_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function markNotificationRead(id) {
  const db = await openNotifDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTIF_STORE, "readwrite");
    const store = tx.objectStore(NOTIF_STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const item = getReq.result;
      if (item) {
        item.read = true;
        store.put(item);
      }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function markAllNotificationsRead() {
  const db = await openNotifDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTIF_STORE, "readwrite");
    const cursorReq = tx.objectStore(NOTIF_STORE).openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      if (!cursor.value.read) {
        cursor.value.read = true;
        cursor.update(cursor.value);
      }
      cursor.continue();
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(diff / 3600000);
  const d = Math.floor(diff / 86400000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 7) return `${d}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

async function setupNotifications() {
  const btn = document.getElementById("notifications");
  const panel = document.getElementById("notif-panel");
  const backdrop = document.getElementById("notif-backdrop");
  const closeBtn = document.getElementById("notif-close");
  const markAllBtn = document.getElementById("notif-mark-all");
  const list = document.getElementById("notif-panel-list");
  const subEl = document.getElementById("notif-panel-sub");
  const countEl = document.getElementById("notif-count");
  if (!btn || !panel) return;
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

  async function updateBadge() {
    try {
      const items = await getAllNotifications();
      const unread = items.filter((i) => !i.read).length;
      if (unread > 0) {
        countEl.hidden = false;
        countEl.textContent = unread > 99 ? "99+" : String(unread);
      } else {
        countEl.hidden = true;
      }
      markAllBtn.hidden = unread === 0;
    } catch (err) {
      console.error("Badge update failed:", err);
    }
  }

  async function renderList() {
    try {
      const items = (await getAllNotifications()).sort(
        (a, b) => b.timestamp - a.timestamp
      );
      if (items.length === 0) {
        list.innerHTML = `<div class="notif-empty">No notifications yet.<br>The daily refresh will show up here.</div>`;
        return;
      }
      list.innerHTML = items
        .map(
          (item) => `
        <div class="notif-item ${item.read ? "read" : "unread"}" data-id="${item.id}">
          <div class="notif-item-title">${escapeAttr(item.title || "Update")}</div>
          <div class="notif-item-body">${escapeAttr(item.body || "")}</div>
          <div class="notif-item-meta">
            <span class="notif-item-time">${formatRelativeTime(item.timestamp)}</span>
            <button type="button" class="notif-item-mark" data-mark-id="${item.id}">Mark read</button>
          </div>
        </div>
      `
        )
        .join("");
    } catch (err) {
      list.innerHTML = `<div class="notif-empty">Failed to load notifications: ${escapeAttr(err.message)}</div>`;
    }
  }

  async function renderSubscriptionState() {
    if (!VAPID_PUBLIC_KEY) {
      subEl.innerHTML = `Notifications aren't configured yet — see <code>NOTIFICATIONS_SETUP.md</code>.`;
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission === "denied") {
      subEl.innerHTML = `Notification permission blocked. Allow it in your browser settings to enable updates.`;
      return;
    }
    const sub = await registration.pushManager.getSubscription();
    if (sub) {
      subEl.innerHTML = `<button type="button" class="notif-sub-btn" data-action="unsubscribe">Unsubscribe</button><span>Subscribed to daily updates.</span>`;
    } else {
      subEl.innerHTML = `<button type="button" class="notif-sub-btn" data-action="subscribe">Subscribe</button><span>Get a Chrome notification each time the daily routine refreshes the data.</span>`;
    }
  }

  async function refreshPanel() {
    await renderSubscriptionState();
    await renderList();
    await updateBadge();
  }

  function openPanel() {
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    btn.setAttribute("aria-expanded", "true");
    backdrop.hidden = false;
    requestAnimationFrame(() => backdrop.classList.add("open"));
    refreshPanel();
  }

  function closePanel() {
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    btn.setAttribute("aria-expanded", "false");
    backdrop.classList.remove("open");
    setTimeout(() => {
      backdrop.hidden = true;
    }, 220);
  }

  btn.addEventListener("click", () => {
    if (panel.classList.contains("open")) closePanel();
    else openPanel();
  });
  closeBtn.addEventListener("click", closePanel);
  backdrop.addEventListener("click", closePanel);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && panel.classList.contains("open")) closePanel();
  });

  subEl.addEventListener("click", async (e) => {
    const action = e.target.dataset.action;
    if (action === "unsubscribe") {
      const current = await registration.pushManager.getSubscription();
      if (current) await current.unsubscribe();
      await refreshPanel();
      return;
    }
    if (action === "subscribe") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        await refreshPanel();
        return;
      }
      try {
        const sub = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
        await refreshPanel();
        showSubscriptionModal(JSON.stringify(sub.toJSON(), null, 2));
      } catch (err) {
        console.error("Subscription failed:", err);
        alert("Subscription failed: " + err.message);
      }
    }
  });

  list.addEventListener("click", async (e) => {
    const markBtn = e.target.closest("[data-mark-id]");
    if (!markBtn) return;
    const id = Number(markBtn.dataset.markId);
    await markNotificationRead(id);
    await refreshPanel();
  });

  markAllBtn.addEventListener("click", async () => {
    await markAllNotificationsRead();
    await refreshPanel();
  });

  try {
    const channel = new BroadcastChannel(NOTIF_CHANNEL);
    channel.addEventListener("message", (e) => {
      if (e.data?.type === "new") {
        updateBadge();
        if (panel.classList.contains("open")) renderList();
      }
    });
  } catch {
    // BroadcastChannel unsupported; updates show on next page load
  }

  await updateBadge();
}

document.getElementById("refresh")?.addEventListener("click", refresh);
setupPageNav();
setupParallax();
setupTooltip();
setupCarousel();
setupOverview();
setupViewSwitcher();
setupNotifications();
refresh();
