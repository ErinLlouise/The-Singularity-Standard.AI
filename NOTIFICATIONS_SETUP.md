# Browser push notifications — one-time setup

Each time the daily routine commits to `data.json`, a GitHub Action sends a Chrome
notification — even if Chrome is closed. This file lists the steps to wire it up
once. After this, it's automatic.

## 1. Generate VAPID keys

VAPID is the auth protocol Chrome's push service uses to verify your server.
Generate a fresh keypair (no Node install needed — `npx` fetches it on the fly):

```bash
npx web-push generate-vapid-keys
```

The output looks like:

```
Public Key:
BPxq…long base64url string…

Private Key:
dXY…shorter base64url string…
```

Keep this terminal window open — you'll paste both keys in the next two steps.

## 2. Set `VAPID_PUBLIC_KEY` in `app.js`

Open [app.js](app.js) and find this line near the top:

```js
const VAPID_PUBLIC_KEY = ""; // Generate with `npx web-push generate-vapid-keys`…
```

Paste your **public** key inside the quotes. Commit and push.

The private key never goes in the page — only the public key.

## 3. Add three secrets to the GitHub repo

Go to https://github.com/ErinLlouise/The-Singularity-Standard.AI/settings/secrets/actions
and add:

| Name | Value |
|---|---|
| `VAPID_PUBLIC_KEY` | the public key from step 1 |
| `VAPID_PRIVATE_KEY` | the private key from step 1 |
| `PUSH_SUBSCRIPTION` | (you'll get this in step 5) |

## 4. Subscribe in Chrome

1. Open http://localhost:8000 in Chrome (the python http.server has to be running locally).
2. Click the **🔔 Notify me** button in the header.
3. Grant notification permission when Chrome asks.
4. A modal appears with a JSON blob. That's your push subscription.
5. Copy it.

## 5. Add the subscription as the third secret

Back at https://github.com/ErinLlouise/The-Singularity-Standard.AI/settings/secrets/actions,
add `PUSH_SUBSCRIPTION` with the JSON blob from step 4 as its value.

## 6. Test it

Make a trivial change to `data.json` (e.g. bump `lastUpdated` by one day),
commit, and push. Within ~30 seconds:

- The workflow run shows up at https://github.com/ErinLlouise/The-Singularity-Standard.AI/actions
- Chrome surfaces a notification titled "AGI Tracker refreshed"

Clicking the notification opens the tracker.

## Maintenance notes

- **Subscription gone (`410 Gone` or `404 Not Found`)**: subscriptions expire if
  you clear browser data, reinstall Chrome, or revoke notification permission.
  Re-click "🔔 Notify me", grab the new JSON, update `PUSH_SUBSCRIPTION`.
- **More devices**: a subscription is per-browser-per-device. To get pings on
  both laptop and phone, the workflow needs to iterate over an array of
  subscriptions. Tell me if you want that.
- **Pause notifications**: just delete the `PUSH_SUBSCRIPTION` secret. The
  workflow's first step exits gracefully when secrets are missing.
- **Local HTTPS not required**: localhost is exempt from the service-worker
  HTTPS rule. If you ever deploy this to a real domain, that domain must serve
  over HTTPS.
