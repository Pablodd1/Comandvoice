# VoiceLayer (Phase 0 spike, v0.3.0)

A drop-in voice layer for any site: **one `<script>`, vanilla JS + CSS, Shadow DOM, no build step, no LLM.**
The core is the **glass voice-wave visual**: a full-page frosted glass over the page, a glowing circle, and radial waves
that move with the visitor's voice and the assistant's voice. The site underneath is only an example backdrop.
The assistant speaks first (after one tap) and works for any intent: wellness, training, coaching, support, or your own rules.

Nothing is deployed publicly. No paid service is enabled without the owner's approval.

## Local URLs (dev sandbox)
- `/voicelayer/demo-glass` glass mode + companion (`?preset=wellness|training|coaching|support|none&lang=es&lite=false&debug=true`)
- `/voicelayer/demo`, `/voicelayer/demo-es` classic assistant (orb + panel)
- `/api/voice/config|token|speak|listen` Hono routes (Deepgram proxy, kill switch, rate limits)

## Features
- Glass layer (real backdrop blur, auto-lite on weak devices); the page stays clickable and scrollable underneath
- Wake tap, then the assistant speaks first, then the mic opens. Asleep = no mic, no voice
- Companion engine: presets, rules, signals (object / function / Promise / URL / `setSignals`), approved catalog, "why am I seeing this"
- Voice control of everything: next, skip, why, repeat, yes/no, mute, pause, minimize, turn off, language
- EN + ES, Deepgram STT/TTS with browser fallback, owner kill switch, visitor always in control
- Guardrails: no diagnosis wording, approved items only, Rx routed to the provider, crisis = safety message only, opt-out, stale data never shown, demo data badged

## Data and storage
No database. Visitor preferences (language, opt-out, turn-off) live in the browser's localStorage. Signals come from the host site.
Secrets (`DEEPGRAM_API_KEY`) live only in Worker env / `.dev.vars` (gitignored).

## Tests (Playwright, mocked mic / speech / Deepgram)
- `run.mjs` T1-T27 (core widget) and `glass.mjs` T28-T37 (glass, wake flow, companion, guardrails, controls, mobile, kill switch, Deepgram mock)
- Last results are in the final report; details in `public/voicelayer/README.md`

## Docs
Integration guide: `public/voicelayer/README.md` (2b glass, 2c companion, guardrails, legal note).

## Status and open items
- Verified on mocks only: real Chrome SpeechRecognition accuracy, real Deepgram session, Safari/iOS, low-end phone performance
- Needed from the owner: `DEEPGRAM_API_KEY` (Member permission), business + region (legal rules), data sources, recommendation policy, hosting for the real API
- Local run: `npm run build && pm2 start ecosystem.config.cjs` (port 3000)
