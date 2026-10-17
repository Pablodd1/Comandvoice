# VoiceLayer self-test (v0.6.0)

What was tested, how, and what was NOT tested. Read the last section before trusting it in production.

## How it was tested
Playwright (Chromium) + JSDOM automated verification suites against the widget, with **mocks** for: microphone (`getUserMedia`), `SpeechRecognition`,
`speechSynthesis`, and the Deepgram WebSocket / `/api/voice/*` routes. Real: the DOM, Shadow DOM, CSS (including real
`backdrop-filter`), Canvas rendering, Web Audio analysers, click/scroll pass-through, the widget code itself.

| Suite | File | Scope |
|---|---|---|
| T1-T27 | `run.mjs` | core widget: scan, commands, receipts, EN/ES, minimize / turn off / bring back, bubble, kill switch, Deepgram mock |
| T28-T38 | `glass.mjs` | travelling voice line, glass layer, wake tap, companion flow, other intents, guardrails, controls, phone, kill switch / file://, Deepgram mock |
| T44-T52 | `tests/verify-v060.mjs` | v0.6.0 inventory & catalog engine (DOM + Schema.org JSON-LD + `setInventory`), price/stock/filter/compare queries, cart awareness (`setCart` + DOM read-back), spatial & behavioral learning (`where am I`, `what am I looking at`, deictic `how much is this` / `is this in stock` / `add this to cart`), user profile & goal-based recommendations, custom actions registry, top-dock 1:1 layout, and context-aware `aiAnswer(q, ctx)` with `CP_LINT` guardrails |

Run: `node tests/verify-v060.mjs` to run the deterministic v0.6.0 verification suite.

## What the suites prove (measured)
- No mic access and nothing spoken before the wake tap; exactly one `getUserMedia` after it
- Opening line is spoken first, then the mic opens (never over the assistant's own voice)
- The page behind the glass stays clickable and scrollable; clicking or typing on the page does not wake the assistant
- Voice commands: next, skip, why, repeat, yes/no, mute, unmute, pause, minimize, turn off, language switch
- v0.6.0 Spatial & Inventory commands (EN & ES): stock overview, item price, item availability, price filter (`under $X`), cheapest/most expensive, 2-item comparison, cart status, spatial location (`where am I`), active focus (`what am I looking at`), deictic commands (`how much is this`, `is this in stock`, `add this to cart`), session browsing history (`what have I looked at`), user profile goals & catalog recommendations, custom registered actions
- Guardrails: unapproved items never offered, Rx items routed not offered, empty disclosure impossible, diagnose/instruct rule text dropped (`CP_LINT`),
  stale data not presented, crisis phrases (EN/ES) get the safety message only, "no suggestions" opt-out holds, sensitive fields/facts refused
- Demo data is badged and announced out loud; events contain ids, not values
- Receipts are honest: `verified === (verification === "read_back")`
- Kill switch hides the widget; works from `file://`; host page DOM is untouched
- Phone viewport layout; reduced-motion; lite mode removes backdrop blur; top-dock renders at 1:1 readable typography

## What is NOT tested (unmeasured)
- Real Chrome `SpeechRecognition` accuracy, accents, noise, real mic levels
- A live Deepgram session (needs `DEEPGRAM_API_KEY`); only mocks and endpoint shape were checked
- Safari / iOS / Firefox behaviour (autoplay rules, `backdrop-filter`, AudioWorklet)
- Frame rate and battery on low-end phones; `lite:'auto'` is only measured on this sandbox
- Screen readers (labels and roles exist; no real assistive-tech run)
- Legal compliance for any region. Not a legal review.
- Real user data: all companion tests use demo data

## v0.4 – v0.6.0 additions
T39 voice preference (server defaults and env override against real wrangler instances, browser voice ranking, Deepgram request voice). T40 forms. T41 memory. T42 knowledge. T43 integration. T44–T52 v0.6.0 Live Inventory, Spatial & Deictic Intelligence, Behavioral Learning, User Profile Recommendations, Custom Host Actions, Top-Dock 1:1 Glass Layout, and Context-Aware `aiAnswer`.

