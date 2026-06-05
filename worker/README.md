# Deadly Serious — Cloudflare Worker

A small Worker that brokers Anthropic API calls for two frontend features:

- **`action: "doom"`** — generates the "How f*cked are you?" verdict from a job title, industry, and role nature.
- **`action: "tools"`** — generates tool recommendations tailored to the user's role for "What to do now — for my role."

The Anthropic API key never leaves the Worker (stored as a Cloudflare secret). An origin allowlist prevents random sites from spending your credit.

## One-time setup

You need a free [Cloudflare account](https://dash.cloudflare.com/sign-up) and the Wrangler CLI.

```bash
# 1. Install Wrangler globally (or use `npx wrangler` everywhere)
npm install -g wrangler

# 2. Authenticate against your Cloudflare account
wrangler login

# 3. From this directory, set the Anthropic API key as a secret
cd worker
wrangler secret put ANTHROPIC_API_KEY
# Paste your sk-ant-... key when prompted. It's stored encrypted in CF.

# 4. Deploy the worker
wrangler deploy
```

Wrangler prints the deployed URL on success, e.g.:

```
Published deadly-serious-worker (1.23 sec)
  https://deadly-serious-worker.<your-cf-name>.workers.dev
```

## Wire it to the frontend

Open `config.js` in the project root and set:

```js
window.DEADLY_SERIOUS_CONFIG = {
  workerUrl: "https://deadly-serious-worker.<your-cf-name>.workers.dev",
};
```

Commit and push. Done.

## Adding more allowed origins

The Worker only accepts requests from origins listed in `ALLOWED_ORIGINS` inside `worker.js`. Localhost on ports 3000 and 8000 are pre-allowed for dev. When you deploy the static site to a real domain, add it to the list and redeploy:

```bash
wrangler deploy
```

## How requests look

Both endpoints accept a POST with a JSON body:

```json
{
  "action": "doom",
  "jobTitle": "junior copywriter",
  "industry": "marketing",
  "roleNature": "creative"
}
```

`roleNature` must be one of: `creative`, `strategic`, `technical`, `administrative`.

Response (200) for `doom`:

```json
{
  "verdict": "pretty cooked",
  "percentage": 70,
  "tasksAutomatable": 80,
  "timeline": "12-18 months",
  "evolution": "shift",
  "harderToReplace": "...",
  "industryContext": "..."
}
```

Response (200) for `tools`:

```json
{
  "intro": "...",
  "tools": [
    { "name": "Claude", "why": "...", "url": "https://claude.ai/" }
  ]
}
```

Errors return `{ "error": "message" }` with appropriate status codes (400 bad input, 403 forbidden origin, 502 upstream API failure).

## Cost & rate notes

- Cloudflare Worker free tier: 100k requests/day. Far more than this site will need.
- Anthropic API: every successful generation hits Claude Sonnet 4 (~1k tokens out, ~200 in). At current pricing this is on the order of $0.01 per call. With realistic traffic this stays under a dollar.
- The Worker has an origin allowlist but no per-IP rate limit. If you put the site somewhere with real traffic, consider adding KV-based rate limiting (~30 lines).

## Updating the model

The model is pinned in `worker.js` as `claude-sonnet-4-20250514`. To swap to a newer Sonnet (e.g. `claude-sonnet-4-6`), edit the `MODEL` constant and redeploy with `wrangler deploy`. No frontend changes needed.

## Local dev

`wrangler dev` runs the Worker locally on `http://localhost:8787`. You can temporarily point `config.js` at that URL while iterating on the Worker without redeploying:

```js
workerUrl: "http://localhost:8787",
```

You'll need to set the secret for local dev separately or use `.dev.vars`:

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
wrangler dev
```

`.dev.vars` is gitignored by default in fresh Wrangler projects, but double-check this repo's `.gitignore` if you add it.
