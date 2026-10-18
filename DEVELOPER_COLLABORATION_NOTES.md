# VoiceLayer (`Comandvoice`) × Host Platform (`John-wellness-`) — Developer Collaboration & Integration Notes

> **Shared Collaboration Document** across `Comandvoice` (VoiceLayer engine) and `John-wellness-` (CuasarX Longevity By Keel host platform).
> **Purpose:** Document how VoiceLayer absorbs any website + closed user profile data, what options exist for site/profile integration, what was wired for the `demo@quasarkeel.com` test deployment, and open items/questions for co-development.

---

## 1. Architectural Options for Absorbing Any Website & User Profile

VoiceLayer is designed as a **4-Tier Hybrid Site & Profile Absorption Engine** so it works out-of-the-box on any website while supporting deep integration with authenticated ("closed") user state:

### Option A — Automatic DOM, Card & Schema.org Absorption (Zero-Config, Always On)
- **How it works:** `CONFIG.knowledge = true` (now enabled by default in `public/voicelayer/voicelayer.js`) automatically indexes:
  1. **Headings & React/Tailwind Cards (`Knowledge.extract`):** Scans `h1..h5`, `[role=heading]`, `<dt>`, and walks up flex-wrapped headers to their enclosing `<article>`, `<section>`, or `.rounded-2xl`/`.rounded-3xl` card container to extract full prose passages.
  2. **FAQ / Details Accordions:** Automatically indexes `<details><summary>` pairs and `<dl><dt><dd>` lists.
  3. **JSON-LD (`application/ld+json`) & Meta Tags:** Extracts `Product`, `FAQPage`, `Organization`, and page description metadata.
  4. **Product Cards & Interactive Controls (`Inventory.scan` + `Scanner.scan`):** Automatically indexes product prices, stock badges, buttons, links, tabs, and inputs—keeping them live via `MutationObserver` as the user switches SPA tabs.

### Option B — Live Closed-Data / User Profile Push (`VoiceLayer.setProfile`, `setSignals`, `setKnowledge`, `setInventory`, `setCart`)
- **How it works:** When a host React/Next/Vue app has authenticated state (or SPA tabs that aren't mounted in the DOM yet), the host pushes structured data directly into VoiceLayer's runtime memory:
  - `window.VoiceLayer.setProfile(profileObj)` — Stores user identity, goals, readiness, sleep/HRV/RHR/training load, today's training plan, daily calorie/macro/hydration targets, organ longevity (AOSM biological age & organ reserve), longitudinal blood biomarkers, and active biohacking protocols.
  - `window.VoiceLayer.setSignals(signalsObj)` — Feeds daily briefing signals (`metrics`, `calendar`, `toTake`, `toBuy`, `weather`, `loyalty_points`).
  - `window.VoiceLayer.setKnowledge(factsArray)` — Injects site-wide domain knowledge or unmounted tab summaries (`[{ heading, text }]`) so the user can ask about any feature of the platform regardless of which tab is currently open.
  - `window.VoiceLayer.setInventory(itemsArray)` & `window.VoiceLayer.setCart(cartObj)` — Synchronizes the full product catalog and shopping cart state.

### Option C — Context-Grounded AI Brain Cascade (`CONFIG.aiAnswer` → `/api/voice/ask` → Local BM25/Token Fallback)
- **How it works:** When a user asks an open-ended question by voice or text, VoiceLayer builds a unified live snapshot (`VL.contextSnapshot()`) containing:
  - `page` (URL, title, lang)
  - `spatial` (active hovered/focused product, current section, visible controls)
  - `inventory` & `cart`
  - `profile` (including full `profile.details`)
  - `signals` & `briefing` (weather, calendar, pending supplements to take, pending refills to buy)
  - `pagePassages` (top 20 absorbed DOM + profile + custom knowledge passages)
- **3-Stage Resolution Cascade (`VL.aiAnswerFlow`):**
  1. **Stage 1 (`CONFIG.aiAnswer(question, ctx)`):** Calls the host app's custom AI hook (e.g., `/api/coach` in `John-wellness-`) with `{ ...window.__CUASARX_COACH_CTX, voiceLayerContext: ctx }`.
  2. **Stage 2 (`Net.ask` → `POST /api/voice/ask`):** If `aiAnswer` is not configured or returns `null`, VoiceLayer automatically calls `POST /api/voice/ask` (`xAI Grok / DeepSeek / Gemini` + `synthesizeFromContext`).
  3. **Stage 3 (`Knowledge.ask(question)`):** Deterministic client-side passage & profile matcher so the assistant never fails even offline.

### Option D — Crawl / Sitemap / RAG Vector Index (Optional Phase 2 for Multi-Page Docs)
- For sites with hundreds of separate static URLs (e.g. clinical research libraries or PDFs not loaded in the SPA bundle), we can optionally add a build-time or edge-cached `/voicelayer-knowledge.json` index that `VoiceLayer.setKnowledge(...)` preloads on boot.

---

## 2. What Was Integrated Today in Both Repos

### In `Comandvoice` (VoiceLayer Engine & Server)
1. **`public/voicelayer/voicelayer.js`:**
   - Enabled `CONFIG.knowledge = true` by default so VoiceLayer automatically absorbs any website it is deployed on.
   - Upgraded `Knowledge.extract()` to traverse modern React/Tailwind card layouts (`article`, `section`, `.rounded-2xl`, `.rounded-3xl`) when headings are wrapped inside flex header rows.
   - Added `Knowledge.dynamicFacts()` to automatically convert `Profile.get()` (`details.readiness`, `metrics`, `trainingPlan`, `nutrition`, `flags`, `organHealth`, `biologicalAge`, `biomarkers`, `biohackingProtocols`), `Signals.all()`, and `Inventory.items()` into searchable knowledge passages.
   - Exposed `window.VoiceLayer.setKnowledge(facts)` and `window.VoiceLayer.knowledge`.
   - Fixed `Companion.intercept()` during `stage === 'mood'` so if the user asks a real question right after the greeting (instead of saying *"good"* or *"tired"*), it immediately answers their question rather than treating it as a mood check-in.
   - Updated `VL.contextSnapshot()` to include `pagePassages` and updated `VL.aiAnswerFlow()` so when `CONFIG.aiAnswer` returns `null`, it seamlessly falls back to `Net.ask()` (`/api/voice/ask`) and `VL.knowledge()`.
2. **`src/index.tsx` (`POST /api/voice/ask`):**
   - Upgraded `synthesizeFromContext()` and the LLM system prompt to answer directly from `ctx.profile.details`, `ctx.pagePassages`, `ctx.signals`, `ctx.briefing`, and `ctx.inventory`.

### In `John-wellness-` (CuasarX Host Platform)
1. **`src/App.tsx`:**
   - Connected `activeUser` (`UserProfile`), `calculateOrganSystems(activeUser)`, `generateExecutiveReport(activeUser)`, `BIOHACKING_PROTOCOLS`, and `MOCK_PRODUCTS` to:
     - `window.VoiceLayer.setProfile(...)` (full biometrics, readiness, training plan, macros/hydration, biological age, 9 organ systems, blood/DEXA/VO2 biomarkers, biohacking protocols, and active regimen).
     - `window.VoiceLayer.setKnowledge(...)` (core platform sections & clinical capabilities so questions about any tab work immediately).
     - `window.__CUASARX_COACH_CTX` (enriched with `profileDetails` and full product catalog metadata).
   - Added `activeTab` to the sync dependencies so switching tabs triggers `VoiceLayer.rescan()` to absorb newly rendered tab DOM.
2. **`index.html`:**
   - Added `knowledge: { autoNav: false, minScore: 0.45 }` to `window.VoiceLayerConfig`.
   - Updated `aiAnswer(question, ctx)` so interactive voice questions work out-of-the-box for `demo@quasarkeel.com` testers (only blocking `/api/coach` if the user explicitly withdrew `ai_processing` consent in Privacy & Consent), and merged `voiceLayerContext: ctx` into the `/api/coach` payload.
3. **`api/coach.js`:**
   - Allowed guest/demo voice queries to use `/api/coach`, injected `ctx.profileDetails` and `ctx.voiceLayerContext.pagePassages` into the system prompt, and added `synthesizeCoachFallback(message, ctx)` so `/api/coach` returns accurate profile/site answers even if server LLM keys aren't set in a preview environment.

---

## 3. Public JS API Contract for Host Developers

```ts
// 1. Push full authenticated user profile & closed telemetry
window.VoiceLayer.setProfile({
  name: 'Alex Mercer',
  age: 42,
  role: 'Managing Partner',
  lifestylePersona: 'Executive Triathlete',
  goals: ['VO2 Max Optimization', 'Deep Sleep Architecture'],
  summary: 'Optional 1-paragraph summary for LLM prompt',
  readiness: { score: 88, status: 'optimal', recommendation: '...' },
  metrics: { sleep: { current: 7.8, baseline: 8.0 }, hrv: { current: 74, baseline: 68 }, rhr: { current: 51 }, trainingLoad: { current: 640 } },
  trainingPlan: { todaysWorkout: 'Zone 2 Endurance Ride (60 min)', recommendedIntensity: 'Moderate', adjustmentReason: '...' },
  nutrition: { dailyCalorieTarget: 2850, macros: { proteinGrams: 195, carbsGrams: 310, fatGrams: 88 }, hydrationLiters: 3.8 },
  biologicalAge: 38.4,
  organHealth: [{ name: 'Cardiovascular System', biologicalAge: 36.2, biologicalReservePercent: 94, status: 'optimal' }],
  biomarkers: 'ApoB 62 mg/dL, hs-CRP 0.4 mg/L, Fasting Glucose 86 mg/dL, HbA1c 5.0%',
});

// 2. Push site-wide facts / unmounted SPA tab knowledge
window.VoiceLayer.setKnowledge([
  { heading: 'Organ Longevity (AOSM)', text: '...' },
  { heading: 'Telemedicine Visits', text: '...' },
]);

// 3. Push daily briefing signals (weather, calendar, meds to take, refills to buy)
window.VoiceLayer.setSignals({
  name: 'Alex',
  metrics: { readiness: { value: 88, unit: '' }, sleep_hours: { value: 7.8, unit: 'h' }, hrv: { value: 74, unit: 'ms' } },
  calendar: [{ title: 'Weekly review', time: '15:00', location: 'Zoom' }],
  toTake: [{ name: 'Magnesium Glycinate', dose: '400mg', time: 'Evening', taken: false }],
  toBuy: [{ name: 'Creatine Monohydrate', daysRemaining: 4, price: '$42', status: 'low' }],
  weather: { tempC: 27, tempF: 81, raining: false, dry: true, condition: { en: 'clear and dry' } }
});

// 4. Trigger DOM & knowledge rescan after SPA route/tab change
window.VoiceLayer.rescan();
```

---

## 4. Questions & Coordination Notes for the Other Developer

1. **Supabase Live Profile vs. Synthetic Persona Switching (`src/App.tsx`):**
   - Right now, `activeUser` defaults to `SYNTHETIC_USERS[0]` and can be switched via the persona selector, while `authProfile` holds Supabase `profiles` rows (`full_name`, `goals`, `loyalty_points`).
   - **Question:** As you move more fields (bloodwork, organ modeling inputs, or daily check-ins) from `SYNTHETIC_USERS` into Supabase tables, should we merge `authProfile` overrides on top of `activeUser` before calling `VoiceLayer.setProfile(...)`, or will `activeUser` itself be hydrated from Supabase?
2. **AI Processing Consent Gate (`index.html` & `src/lib/consent.tsx`):**
   - We updated `index.html` so interactive voice Q&A works by default during testing unless `ai_processing` was explicitly withdrawn (`granted === false && withdrawnAt`), and falls back to VoiceLayer's context engine if `/api/coach` returns `null`.
   - **Question:** For production compliance, do you want `FirstRunConsent` to include a one-click toggle for `ai_processing` on first login, or should interactive voice Q&A be treated as user-initiated (implied consent per query) while background AI coaching remains opt-in?
3. **Syncing `voicelayer.js` Between Repos:**
   - Whenever `Comandvoice/public/voicelayer/voicelayer.js` is updated and built (`npm run build`), copy `public/voicelayer/voicelayer.js`, `voicelayer.min.js`, and `voicelayer.css` into `John-wellness-/public/voicelayer/`.
