#!/usr/bin/env node
// Deterministic arena refresh. Pulls structured rows from the HuggingFace
// datasets-server for lmarena-ai/leaderboard-dataset across 5 categories,
// applies a provider lookup table, runs sanity checks, snapshots history
// before overwriting, computes deltas + badges, fails loudly on any error.
//
// No LLM in this path. If something looks wrong, the human / repair agent
// looks at it.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

// Built-in `fetch` arrived in Node 18. Use it when available; fall back to a
// minimal https-based polyfill for older Node so the script also runs locally
// on whatever the dev has installed.
const httpFetch =
  globalThis.fetch ||
  ((url, opts = {}) =>
    new Promise((res, rej) => {
      https
        .get(url, { headers: opts.headers || {} }, (r) => {
          let body = "";
          r.on("data", (c) => (body += c));
          r.on("end", () =>
            res({
              ok: r.statusCode >= 200 && r.statusCode < 300,
              status: r.statusCode,
              statusText: r.statusMessage,
              json: async () => JSON.parse(body),
            })
          );
        })
        .on("error", rej);
    }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DATA_DIR = resolve(ROOT, "data");
const HISTORY_DIR = resolve(DATA_DIR, "history");
const LEADERBOARD_PATH = resolve(DATA_DIR, "leaderboard.json");

// ─── Category map: tab id → HF config name ──────────────────────────────
const CATEGORIES = [
  { id: "conversation", label: "The Conversation", config: "text_style_control" },
  { id: "codebase",     label: "The Codebase",     config: "webdev" },
  { id: "image",        label: "The Image",        config: "text_to_image" },
  { id: "reel",         label: "The Reel",         config: "text_to_video" },
  { id: "eye",          label: "The Eye",          config: "vision" },
];

// ─── Provider normalization: HF organization field → canonical lab id ──
const ORG_ALIAS = {
  "openai": "openai",
  "anthropic": "anthropic",
  "google": "google",
  "google deepmind": "google",
  "deepmind": "google",
  "meta": "meta",
  "meta ai": "meta",
  "meta-llama": "meta",
  "xai": "xai",
  "x.ai": "xai",
  "x-ai": "xai",
  "deepseek": "deepseek",
  "deepseek-ai": "deepseek",
  "mistral": "mistral",
  "mistral ai": "mistral",
  "mistralai": "mistral",
  "alibaba": "alibaba",
  "alibaba cloud": "alibaba",
  "qwen": "alibaba",
  "qwen-team": "alibaba",
  "cohere": "cohere",
  "cohereforai": "cohere",
  "reka": "reka",
  "reka ai": "reka",
  "01-ai": "01-ai",
  "01.ai": "01-ai",
  "zhipu": "zhipu",
  "zhipu ai": "zhipu",
  "thudm": "zhipu",
  "tencent": "tencent",
  "nvidia": "nvidia",
  "amazon": "amazon",
  "microsoft": "microsoft",
  "stability ai": "stability",
  "stabilityai": "stability",
  "black forest labs": "bfl",
  "black-forest-labs": "bfl",
  "runway": "runway",
  "runwayml": "runway",
  "luma": "luma",
  "luma ai": "luma",
  "pika": "pika",
  "pika labs": "pika",
  "midjourney": "midjourney",
  "ideogram": "ideogram",
  "kling": "kling",
  "kling ai": "kling",
  "kuaishou": "kling",
};

const LAB_DISPLAY = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google DeepMind",
  meta: "Meta",
  xai: "xAI",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  alibaba: "Alibaba (Qwen)",
  cohere: "Cohere",
  reka: "Reka",
  "01-ai": "01.AI",
  zhipu: "Zhipu",
  tencent: "Tencent",
  nvidia: "NVIDIA",
  amazon: "Amazon",
  microsoft: "Microsoft",
  stability: "Stability AI",
  bfl: "Black Forest Labs",
  runway: "Runway",
  luma: "Luma",
  pika: "Pika",
  midjourney: "Midjourney",
  ideogram: "Ideogram",
  kling: "Kling",
};

// Model name prefix → expected lab. Used to sanity-check rows where the
// dataset's `organization` field looks suspicious.
const PREFIX_RULES = [
  [/^gpt[-_]/i, "openai"],
  [/^o[1-9](-|$)/i, "openai"],
  [/^chatgpt-/i, "openai"],
  [/^codex-/i, "openai"],
  [/^dall-e/i, "openai"],
  [/^sora-/i, "openai"],
  [/^claude-/i, "anthropic"],
  [/^gemini-/i, "google"],
  [/^gemma-/i, "google"],
  [/^imagen-/i, "google"],
  [/^veo-/i, "google"],
  [/^llama-/i, "meta"],
  [/^muse-/i, "meta"],
  [/^movie-gen/i, "meta"],
  [/^emu-/i, "meta"],
  [/^grok-/i, "xai"],
  [/^deepseek-/i, "deepseek"],
  [/^mistral-/i, "mistral"],
  [/^mixtral-/i, "mistral"],
  [/^qwen/i, "alibaba"],
  [/^command-/i, "cohere"],
  [/^aya-/i, "cohere"],
  [/^reka-/i, "reka"],
  [/^yi-/i, "01-ai"],
  [/^glm-/i, "zhipu"],
  [/^hunyuan-/i, "tencent"],
  [/^flux/i, "bfl"],
  [/^sd[-_]/i, "stability"],
  [/^stable-/i, "stability"],
  [/^kling-/i, "kling"],
];

// ─── Helpers ────────────────────────────────────────────────────────────
function normalizeLab(org) {
  if (!org) return null;
  return ORG_ALIAS[org.toLowerCase().trim()] || null;
}

function expectedLabFromPrefix(modelName) {
  if (!modelName) return null;
  for (const [re, lab] of PREFIX_RULES) {
    if (re.test(modelName)) return lab;
  }
  return null;
}

async function fetchCategory(config) {
  // HF datasets-server enforces num_rows_per_page=100, so length>100 returns 422.
  const url = `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=${config}&split=latest&offset=0&length=100`;
  const res = await httpFetch(url, {
    headers: { "User-Agent": "deadly-serious-arena-refresh/1.0" },
  });
  if (!res.ok) {
    throw new Error(
      `HF fetch failed for config="${config}": HTTP ${res.status} ${res.statusText}`
    );
  }
  const data = await res.json();
  return (data.rows || []).map((r) => r.row);
}

async function loadJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf-8"));
}

async function writeJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + "\n");
}

// Find the snapshot closest to (but not after) `daysAgo` days before today.
async function findHistoricalSnapshot(daysAgo = 7) {
  if (!existsSync(HISTORY_DIR)) return null;
  const files = (await readdir(HISTORY_DIR))
    .filter((f) => /^arena-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  if (files.length === 0) return null;
  const target = new Date(Date.now() - daysAgo * 86400000);
  // Find the file with the latest date <= target
  let best = null;
  for (const f of files) {
    const dateStr = f.slice("arena-".length, "arena-".length + 10);
    const fileDate = new Date(dateStr);
    if (fileDate <= target) best = f;
  }
  if (!best) best = files[0]; // fall back to oldest
  return loadJSON(resolve(HISTORY_DIR, best));
}

// ─── Build per-category top labs ────────────────────────────────────────
function buildCategoryTopLabs(rows, prevTopLabs, warnings) {
  // Sort by global rank ascending, then dedupe to 1 entry per lab (best model)
  const seen = new Map(); // lab_id → row
  const sorted = [...rows].filter((r) => r.category === "overall").sort((a, b) => a.rank - b.rank);

  for (const row of sorted) {
    const lab = normalizeLab(row.organization);
    if (!lab) {
      // Unknown org (long tail of small labs we don't track) — silent skip.
      continue;
    }
    // Prefix sanity check: if the model name has a known prefix and it
    // contradicts the org, something's wrong with the dataset row.
    const expected = expectedLabFromPrefix(row.model_name);
    if (expected && expected !== lab) {
      warnings.push(
        `prefix mismatch: model="${row.model_name}" org=${lab} expected=${expected} — dropped`
      );
      continue;
    }
    if (!seen.has(lab)) seen.set(lab, row);
  }

  const top5 = [...seen.entries()].slice(0, 5).map(([labId, row], idx) => {
    const prev = prevTopLabs?.find((p) => p.lab_id === labId);
    return {
      rank: idx + 1,
      lab_id: labId,
      lab_name: LAB_DISPLAY[labId] || labId,
      top_model: row.model_name,
      elo: Math.round(row.rating),
      rating_lower: Math.round(row.rating_lower),
      rating_upper: Math.round(row.rating_upper),
      vote_count: row.vote_count,
      delta_7d: prev ? prev.rank - (idx + 1) : null, // positive = climbed
    };
  });

  return top5;
}

// ─── Build the "War Map" overall view + badges ──────────────────────────
function buildOverallView(categoriesData, prevOverall) {
  const labMap = {};
  for (const cat of CATEGORIES) {
    for (const entry of categoriesData[cat.id] || []) {
      if (!labMap[entry.lab_id]) {
        labMap[entry.lab_id] = {
          lab_id: entry.lab_id,
          lab_name: entry.lab_name,
          ranks_by_category: {},
        };
      }
      labMap[entry.lab_id].ranks_by_category[cat.id] = entry.rank;
    }
  }

  const labs = Object.values(labMap).map((lab) => {
    const ranks = Object.values(lab.ranks_by_category);
    const fronts_won = ranks.filter((r) => r === 1).length;
    const avg_rank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
    return { ...lab, fronts_won, avg_rank, badges: [] };
  });

  labs.sort((a, b) => {
    if (b.fronts_won !== a.fronts_won) return b.fronts_won - a.fronts_won;
    return a.avg_rank - b.avg_rank;
  });

  // Editorial badges
  for (const lab of labs) {
    const ranks = lab.ranks_by_category;
    const categoriesInTop5 = Object.keys(ranks).length;
    const allRanks = Object.values(ranks);

    if (lab.fronts_won >= 3) lab.badges.push("Running the Table");

    if (categoriesInTop5 === 5 && lab.fronts_won === 0) {
      lab.badges.push("Solid B-Tier");
    }
    if (categoriesInTop5 === 5 && allRanks.every((r) => r <= 3) && lab.fronts_won === 0) {
      lab.badges.push("The Quiet Generalist");
    }

    // History-dependent badges
    const prevLab = prevOverall?.labs?.find((l) => l.lab_id === lab.lab_id);
    if (prevLab) {
      const prevRanks = prevLab.ranks_by_category || {};
      let demoted = false, glowingUp = false, flopEra = false;

      for (const cat of CATEGORIES) {
        const cur = ranks[cat.id];
        const prev = prevRanks[cat.id];
        if (prev && !cur) demoted = true;
        if (prev && cur && prev - cur >= 2) glowingUp = true;
        if (prev && cur && cur - prev >= 2) flopEra = true;
      }
      if (demoted) lab.badges.push("Recently Demoted");
      if (glowingUp) lab.badges.push("Glowing Up");
      if (flopEra) lab.badges.push("In Its Flop Era");
    }
  }

  return labs;
}

// ─── Sanity checks ──────────────────────────────────────────────────────
function runSanityChecks(categoriesRaw, categoriesData, warnings) {
  const errors = [];

  // Min model count per category in the raw data
  for (const cat of CATEGORIES) {
    const rows = categoriesRaw[cat.id] || [];
    if (rows.length < 10) {
      errors.push(`${cat.config}: only ${rows.length} rows returned (need >= 10)`);
    }
  }

  // Min labs per category in the deduped output
  for (const cat of CATEGORIES) {
    const labs = categoriesData[cat.id] || [];
    if (labs.length < 3) {
      errors.push(`${cat.id}: only ${labs.length} labs identified (need >= 3)`);
    }
  }

  // No provider claims >60% of any category's top 5 (after dedup this is guaranteed,
  // but we double-check)
  for (const cat of CATEGORIES) {
    const labs = categoriesData[cat.id] || [];
    const counts = {};
    for (const l of labs) counts[l.lab_id] = (counts[l.lab_id] || 0) + 1;
    for (const [labId, n] of Object.entries(counts)) {
      const pct = n / labs.length;
      if (pct > 0.6) {
        errors.push(`${cat.id}: ${labId} holds ${n}/${labs.length} (${(pct * 100).toFixed(0)}%) — sanity rule says ≤60%`);
      }
    }
  }

  // Warning-level: if total warnings exceed a threshold, flag
  if (warnings.length > 20) {
    errors.push(`${warnings.length} parsing warnings — likely schema drift, investigate`);
  }

  return errors;
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  const warnings = [];
  const today = new Date().toISOString().slice(0, 10);

  console.log(`Refreshing arena data for ${today}…`);

  // Fetch all categories from HF
  const categoriesRaw = {};
  for (const cat of CATEGORIES) {
    process.stdout.write(`  fetching ${cat.config}… `);
    categoriesRaw[cat.id] = await fetchCategory(cat.config);
    console.log(`${categoriesRaw[cat.id].length} rows`);
  }

  // Load previous leaderboard for delta computation
  const prevLeaderboard = await loadJSON(LEADERBOARD_PATH);
  const prevArena = prevLeaderboard?.arena_view || null;

  // Build per-category top labs
  const categoryViews = {};
  for (const cat of CATEGORIES) {
    const prevTop = prevArena?.categories?.[cat.id]?.top_labs || [];
    categoryViews[cat.id] = {
      label: cat.label,
      top_labs: buildCategoryTopLabs(categoriesRaw[cat.id], prevTop, warnings),
    };
  }

  // Determine asOf from any row (publish dates should match across rows)
  const asOf =
    categoriesRaw.conversation[0]?.leaderboard_publish_date || today;
  const daysSince = Math.max(
    0,
    Math.floor((Date.parse(today) - Date.parse(asOf)) / 86400000)
  );

  // Build Overall view from per-category top labs
  const overallLabs = buildOverallView(
    Object.fromEntries(
      Object.entries(categoryViews).map(([k, v]) => [k, v.top_labs])
    ),
    prevArena?.overall
  );

  // Sanity checks (run BEFORE writing anything)
  const categoryTopLabs = Object.fromEntries(
    Object.entries(categoryViews).map(([k, v]) => [k, v.top_labs])
  );
  const sanityErrors = runSanityChecks(categoriesRaw, categoryTopLabs, warnings);
  if (sanityErrors.length > 0) {
    console.error("\n✘ Sanity checks failed:");
    for (const e of sanityErrors) console.error("  •", e);
    console.error(`\n(${warnings.length} parsing warnings during this run)`);
    process.exit(2);
  }

  if (warnings.length > 0) {
    console.warn(`\n${warnings.length} parsing warnings (non-fatal):`);
    for (const w of warnings.slice(0, 10)) console.warn("  •", w);
    if (warnings.length > 10) console.warn(`  • …and ${warnings.length - 10} more`);
  }

  // Assemble final arena_view
  const arenaView = {
    source: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
    as_of: asOf,
    days_since_arena_update: daysSince,
    refreshed_at: new Date().toISOString(),
    categories: categoryViews,
    overall: { labs: overallLabs },
  };

  // Write history snapshot FIRST so a partial failure can't lose yesterday's data
  const snapshotPath = resolve(HISTORY_DIR, `arena-${today}.json`);
  await writeJSON(snapshotPath, arenaView);
  console.log(`\nWrote history snapshot → ${snapshotPath.replace(ROOT + "/", "")}`);

  // Then overwrite the current leaderboard
  const newLeaderboard = {
    ...(prevLeaderboard || {}),
    last_arena_refresh: new Date().toISOString(),
    arena_view: arenaView,
  };
  await writeJSON(LEADERBOARD_PATH, newLeaderboard);
  console.log(`Wrote current leaderboard → ${LEADERBOARD_PATH.replace(ROOT + "/", "")}`);

  // Brief summary
  console.log(`\nArena snapshot: ${asOf} (${daysSince} day${daysSince === 1 ? "" : "s"} ago)`);
  console.log(`Overall #1: ${overallLabs[0]?.lab_name} (${overallLabs[0]?.fronts_won} fronts won)`);
  for (const cat of CATEGORIES) {
    const top = categoryViews[cat.id].top_labs[0];
    console.log(`  ${cat.label}: ${top?.lab_name} (${top?.top_model}, Elo ${top?.elo})`);
  }
}

main().catch((err) => {
  console.error("\n✘ Refresh failed:", err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
