# Developer & AI Agent Symbiotic Collaboration Notes (`Comandvoice` VoiceLayer ↔ Host Websites)

**Last Updated:** October 2026  
**Repositories Involved:**
1. **Voice & Agent Layer (`Comandvoice`):** VoiceLayer Widget v0.6.0-vnext (`public/voicelayer/voicelayer.js` & `voicelayer.min.js`)
2. **Reference Host Application (`John-wellness-`):** CuasarX Longevity By Keel (`React 19 + Vite + TypeScript + Supabase + Express API`)
3. **Machine-Readable Agent Manifest:** [`public/llms.txt`](public/llms.txt) & `window.VoiceLayer.symbiosis`

---

## 1. Purpose of This Document (For Human Developers & AI Coding Agents)

This file is the **symbiotic communication contract** between **VoiceLayer (`Comandvoice`)** and **any host website or web app repository** (such as `John-wellness-`).

Whenever a developer or AI coding agent places VoiceLayer on a new website or updates an existing host app, follow this contract so VoiceLayer automatically:
1. **Absorbs 100% of the website's live context** (personal data, biometrics, primary calendar, second work/training/travel calendar, pending items to take, pending items to buy, product catalog, and visible DOM cards).
2. **Isolates multi-user / multi-client profiles and behavioral learning** (`VoiceLayer.setUser(userId, profile)`).
3. **Executes voice commands on every link, button, tab, and form field** with friendly, human readback and closed-loop verification receipts.

---

## 2. The 4-Layer Universal Symbiotic Website-Agent Protocol (`1.0.0-symbiosis`)

VoiceLayer absorbs website and user information through **4 complementary layers** (from zero-code automatic DOM scanning up to full runtime state handshakes):

### Layer 1: Zero-Code Automatic DOM & Card Absorption (Always Active)
Without writing a single line of integration code, `Scanner` and `Knowledge` (`CONFIG.knowledge = true` by default) automatically index:
- All visible headings (`h1`–`h4`), `<p>`, `<li>`, `<dt>`/`<dd>`, `[role="region"]`, and modern React/Tailwind card containers (`div.rounded-*`, `div.border*`, `[class*="card"]`).
- All links, buttons, tabs (`[role="tab"]`), and form inputs (`Forms`).
- Declarative `data-vl-*` attributes:
  - `data-vl-calendar="Dr. Chen Follow-up" data-vl-time="09:00" data-vl-location="Telehealth"`
  - `data-vl-work-calendar="NYC Summit Flight" data-vl-kind="trip" data-vl-time="Tomorrow 07:30"`
  - `data-vl-take="NAD+ Precursor" data-vl-dose="500mg" data-vl-taken="false"`
  - `data-vl-buy="Magnesium L-Threonate" data-vl-days-left="4"`
  - `data-vl-qa-q="Question" data-vl-qa-a="Answer"`

### Layer 2: One-Call Runtime Symbiotic Handshake (`VoiceLayer.symbiosis.handshake`)
Any React, Vue, Next.js, or vanilla JS web app can pass its entire live state in a single call (or set `window.__VOICELAYER_SYMBIOSIS__` before/after script load):

```js
const symbiosisSpec = {
  appName: 'CuasarX Longevity By Keel',
  userId: activeUser.id,           // Isolates profile & learning per user ID
  profile: {
    id: activeUser.id,
    name: activeUser.name,
    role: activeUser.role,
    goals: activeUser.goals,
    readiness: { score: 82, status: 'Optimal', message: 'Ready for high-output focus' },
    metrics: { sleep: { current: 7.5 }, hrv: { current: 64 }, rhr: { current: 52 } },
    biologicalAge: 35.4,
    organHealth: [...],
    biomarkers: 'ApoB 62 mg/dL, hs-CRP 0.4 mg/L, Fasting Glucose 86 mg/dL, VO2 Max 54.2',
    trainingPlan: { todaysWorkout: 'Zone 2 Active Recovery Ride (45 min)', recommendedIntensity: 'Moderate' },
    nutrition: { dailyCalorieTarget: 2600, macros: { proteinGrams: 180, carbsGrams: 250, fatGrams: 80 } }
  },
  // Calendar 1: Primary Clinical / Personal Appointments
  calendar: [
    { title: 'Dr. Chen follow-up (labs & ApoB review)', time: '09:00', location: 'Telehealth', kind: 'medical' },
    { title: 'AOSM Organ Reserve & DEXA Check-in', time: '11:30', location: 'Keel Longevity Clinic', kind: 'medical' }
  ],
  // Calendar 2: Work Meetings, Training Sessions & Business Trips / Flights
  workCalendar: [
    { title: 'Weekly review — Keel Performance Board', time: '15:00', location: 'Zoom', kind: 'work' },
    { title: 'Zone 2 Active Recovery Ride — 45 min', time: '18:30', location: 'Key Biscayne loop', kind: 'training' },
    { title: 'NYC Longevity Summit Flight & Circadian Prep', time: 'Tomorrow 07:30', location: 'MIA → JFK', kind: 'trip' }
  ],
  toTake: [...],
  toBuy: [...],
  inventory: [...],
  knowledge: [...],
  actions: [...]
};

window.__VOICELAYER_SYMBIOSIS__ = symbiosisSpec;
window.VoiceLayer?.symbiosis?.handshake?.(symbiosisSpec);
```

### Layer 3: Declarative JSON & W3C WebMCP Auto-Discovery
On startup (`VL.init()` and post-hydration), `Symbiosis.autoDiscover()` automatically checks:
1. `window.__VOICELAYER_SYMBIOSIS__`
2. `<script type="application/voicelayer+json">...</script>`
3. W3C WebMCP tools (`navigator.modelContext.tools` or `window.__WEBMCP_TOOLS__`)

### Layer 4: Self-Diagnostic Console API for Developers & AI Agents
Any developer or AI agent testing a site can inspect the symbiotic state in real time:
- `window.VoiceLayer.symbiosis.status()` — returns live counts of connected profile fields, biometrics, primary calendar events, work/training/trip calendar events, pending to take/buy, inventory items, knowledge passages, dynamic facts, and DOM controls.
- `window.VoiceLayer.symbiosis.guide()` — returns the self-documented integration guide right in the browser console.

---

## 3. Global & Chinese Open-Source Research Integrated

- **ByteDance `UI-TARS` (`bytedance/UI-TARS`):** Closed-loop action verification receipts (`VL.receipts`) on every DOM action and readback.
- **Zhipu AI / Tsinghua `Open-AutoGLM` & `CogAgent` (`zai-org/Open-AutoGLM`):** Fast local intent resolution (`<15ms`) paired with LLM fallback (`/api/voice/ask` via Groq `llama-3.3-70b-versatile`) and confirmation gates on high-consequence actions.
- **Alibaba `Page-Agent` / `Mobile-Agent` & `Browser-Use`:** Multi-user session isolation (`Profile.setUser`) + live DOM control grounding.
- **Agentic Web Standards (`/llms.txt` + `WebMCP`):** Machine-readable repo manifests (`public/llms.txt` and `DEVELOPER_COLLABORATION_NOTES.md`) for instant repo-to-repo AI developer collaboration.
