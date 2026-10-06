# VoiceLayer self-test (v0.3.0)

What was tested, how, and what was NOT tested. Read the last section before trusting it in production.

## How it was tested
Playwright (Chromium) against the running app, with **mocks** for: microphone (`getUserMedia`), `SpeechRecognition`,
`speechSynthesis`, and the Deepgram WebSocket / `/api/voice/*` routes. Real: the DOM, Shadow DOM, CSS (including real
`backdrop-filter`), Canvas rendering, Web Audio analysers, click/scroll pass-through, the widget code itself.

| Suite | File | Scope |
|---|---|---|
| T1-T27 | `run.mjs` | core widget: scan, commands, receipts, EN/ES, minimize / turn off / bring back, bubble, kill switch, Deepgram mock |
| T28-T37 | `glass.mjs` | glass layer, wake tap, companion flow, other intents, guardrails, controls, phone, kill switch / file://, Deepgram mock |

Run: `cd /home/user/vl_test && node run.mjs && node glass.mjs` with the app on `http://localhost:3000`.
The harness files live outside the web root (`/home/user/vl_test`), not in `public/`.

## What the suites prove (measured)
- No mic access and nothing spoken before the wake tap; exactly one `getUserMedia` after it
- Opening line is spoken first, then the mic opens (never over the assistant's own voice)
- The page behind the glass stays clickable and scrollable; clicking or typing on the page does not wake the assistant
- Voice commands: next, skip, why, repeat, yes/no, mute, unmute, pause, minimize, turn off, language switch
- Guardrails: unapproved items never offered, Rx items routed not offered, empty disclosure impossible, diagnose/instruct rule text dropped,
  stale data not presented, crisis phrases (EN/ES) get the safety message only, "no suggestions" opt-out holds
- Demo data is badged and announced out loud; events contain ids, not values
- Receipts are honest: `verified === (verification === "read_back")`
- Kill switch hides the widget; works from `file://`; host page DOM is untouched
- Phone viewport layout; reduced-motion; lite mode removes backdrop blur

## What is NOT tested (unmeasured)
- Real Chrome `SpeechRecognition` accuracy, accents, noise, real mic levels
- A live Deepgram session (needs `DEEPGRAM_API_KEY`); only mocks and endpoint shape were checked
- Safari / iOS / Firefox behaviour (autoplay rules, `backdrop-filter`, AudioWorklet)
- Frame rate and battery on low-end phones; `lite:'auto'` is only measured on this sandbox
- Screen readers (labels and roles exist; no real assistive-tech run)
- Legal compliance for any region. Not a legal review.
- Real user data: all companion tests use demo data
