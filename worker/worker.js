// Deadly Serious — Anthropic API proxy
//
// A small Cloudflare Worker that brokers Anthropic API calls for two
// frontend features: the personal "How f*cked are you?" verdict and the
// "What to do now — for my role" tool recommendations.
//
// The API key never leaves the Worker (stored as a Cloudflare secret).
// Origin allowlist prevents random sites from burning your credit.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 800;

const ALLOWED_ORIGINS = [
  "http://localhost:8000",
  "http://localhost:3000",
  "http://127.0.0.1:8000",
  // Add your deployed origin(s) here when you have one, e.g.
  // "https://deadlyserious.example.com",
];

const VALID_NATURES = new Set(["creative", "strategic", "technical", "administrative"]);

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Origin allowlist (skip during local Wrangler dev if needed)
    if (!ALLOWED_ORIGINS.includes(origin) && origin !== "") {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method !== "POST") {
      return errorJSON("Use POST", 405, origin);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return errorJSON(
        "Worker is missing ANTHROPIC_API_KEY. Set with `wrangler secret put ANTHROPIC_API_KEY`.",
        500,
        origin
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return errorJSON("Invalid JSON in request body", 400, origin);
    }

    if (body.action === "doom") return handleDoom(body, env, origin);
    if (body.action === "tools") return handleTools(body, env, origin);
    return errorJSON('Unknown action — use "doom" or "tools"', 400, origin);
  },
};

// ─── Section 1: How f*cked are you? ─────────────────────────────────────

async function handleDoom(body, env, origin) {
  const inputs = parseInputs(body);
  if (inputs.error) return errorJSON(inputs.error, 400, origin);

  const system = `You are a darkly comic but informed commentator on AI's impact on jobs. Sharp, satirical — not cruel, not preachy, not a doomer. Treat the prediction as opinionated dark comedy, not financial advice.

Respond with valid JSON ONLY (no prose, no code fences). The JSON must match this shape exactly:

{
  "verdict": string — a punchy 2–5 word verdict like "pretty f*cked", "surprisingly safe", "cooked", "living on borrowed time", "fine for now",
  "percentage": number 0-100 — your dark-comic estimate of how 'f*cked' this role is over the next 3 years (higher = more displaced),
  "tasksAutomatable": number 0-100 — percentage of their daily tasks already automatable by current AI tools,
  "timeline": string — when significant impact hits, e.g. "6-12 months", "2-3 years", "already happening", "5+ years if at all",
  "evolution": "disappear" | "evolve" | "shift" — does the role disappear entirely, evolve into something different, or just shift duties around,
  "harderToReplace": string — 1-2 sentences on what about this person's role keeps them harder to automate. Dark-comic register but pointing at something real (judgment, relationships, physical presence, taste, accountability),
  "industryContext": string — 1-2 sentences on how AI is currently affecting their specific industry. Real observations, dark-comic tone
}

Be specific to the job title and industry. Don't repeat the title back. No moralizing.`;

  const user = `Job title: ${inputs.jobTitle}
Industry: ${inputs.industry || "(not specified)"}
Role nature: ${inputs.roleNature}`;

  const result = await callAnthropic(env.ANTHROPIC_API_KEY, system, user);
  if (!result.ok) return errorJSON(result.error, 502, origin);

  const parsed = parseModelJSON(result.text);
  if (!parsed) return errorJSON("Model returned invalid JSON", 502, origin);

  // Light sanity clamps so the UI doesn't break
  parsed.percentage = clamp(parsed.percentage, 0, 100);
  parsed.tasksAutomatable = clamp(parsed.tasksAutomatable, 0, 100);
  if (!["disappear", "evolve", "shift"].includes(parsed.evolution)) {
    parsed.evolution = "evolve";
  }

  return jsonResponse(parsed, origin);
}

// ─── Section 2: "For my role" tool recommendations ──────────────────────

async function handleTools(body, env, origin) {
  const inputs = parseInputs(body);
  if (inputs.error) return errorJSON(inputs.error, 400, origin);

  const system = `You are recommending AI tools to a specific working professional. The tone is sharp, darkly funny but practical — they want real picks, not vibes.

Respond with valid JSON ONLY (no prose, no code fences). The JSON must match this shape exactly:

{
  "intro": string — 1-2 sentences contextualizing the picks for THIS person's role and industry. Dark-comic register, but the recommendations themselves are sincere,
  "tools": [
    { "name": string, "why": string (1 sentence why it fits THIS role), "url": string (the canonical product URL) }
  ]
}

Recommend 3-5 tools. Mix established options (Claude, ChatGPT, Cursor, Perplexity, Notion AI, etc.) with anything role-specific that genuinely helps. Each "why" should reference something concrete about this person's role, not be generic. Real URLs only.`;

  const user = `Job title: ${inputs.jobTitle}
Industry: ${inputs.industry || "(not specified)"}
Role nature: ${inputs.roleNature}`;

  const result = await callAnthropic(env.ANTHROPIC_API_KEY, system, user);
  if (!result.ok) return errorJSON(result.error, 502, origin);

  const parsed = parseModelJSON(result.text);
  if (!parsed || !Array.isArray(parsed.tools)) {
    return errorJSON("Model returned invalid JSON", 502, origin);
  }

  // Cap to 5, sanity-check each tool
  parsed.tools = parsed.tools
    .filter((t) => t && t.name && t.url)
    .slice(0, 5)
    .map((t) => ({
      name: String(t.name).slice(0, 60),
      why: String(t.why || "").slice(0, 240),
      url: String(t.url).slice(0, 200),
    }));

  return jsonResponse(parsed, origin);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function parseInputs(body) {
  const jobTitle = String(body.jobTitle || "").trim().slice(0, 100);
  const industry = String(body.industry || "").trim().slice(0, 80);
  const roleNature = String(body.roleNature || "").trim();

  if (!jobTitle) return { error: "Job title is required" };
  if (jobTitle.length < 2) return { error: "Job title is too short" };
  if (!VALID_NATURES.has(roleNature)) {
    return { error: `Role nature must be one of: ${[...VALID_NATURES].join(", ")}` };
  }
  return { jobTitle, industry, roleNature };
}

async function callAnthropic(apiKey, system, user) {
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch (err) {
    return { ok: false, error: `Network error calling Anthropic: ${err.message}` };
  }
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: `Anthropic API ${res.status}: ${text.slice(0, 300)}` };
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text || "";
  if (!text) return { ok: false, error: "Empty response from Anthropic" };
  return { ok: true, text };
}

function parseModelJSON(text) {
  // Be lenient with code-fenced output
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Sometimes the model includes a sentence before the JSON. Try to extract.
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function jsonResponse(data, origin) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function errorJSON(message, status, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}
