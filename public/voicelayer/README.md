# VoiceLayer (Phase 0 spike, v0.3.0)

A voice assistant you add to any website with **one `<script>` tag**. It scans the page, talks and listens
(English + Spanish), and performs actions (go / click / find / read) while the visitor stays in control.
Vanilla JS + CSS, no build step, no dependencies. Rule-based grammar, no LLM: page text can never "instruct" it.

> Phase 0 is a pre-M1 spike. Nothing here is deployed publicly; nothing paid is enabled without the owner's approval.

---

## 1. Install in 2 minutes

1. Upload `voicelayer.js` and `voicelayer.css` to the same folder on your host.
2. Paste before `</body>`:

```html
<script src="https://YOUR-SITE/voicelayer/voicelayer.js" defer></script>
```

That's it. Works from `file://` too (open `demo.html`). Browser voice only unless you enable the server routes (section 5).

Optional config (above the script tag):

```html
<script>
  window.VoiceLayerConfig = { language: 'auto', apiBase: '/api/voice', hotkey: 'Alt+Shift+V' };
</script>
```

Or data attributes: `data-language="es" data-api="/api/voice" data-provider="browser" data-corner="bottom-left" data-bubble="false" data-greeting="..." data-debug="true"`.

Size (measured): `voicelayer.js` 154 KB raw / **46 KB gzip**, `voicelayer.css` 19 KB raw / **5 KB gzip**.
Both languages, both engines and the visitor controls are in that file. A minified build would be smaller; not done in Phase 0.

## 2. What it does

| Say / type (EN) | Say / type (ES) | Result |
|---|---|---|
| "go to shipping" | "ve a envíos" | scrolls to the section/page, read-back verified |
| "what is this site?" | "¿qué es este sitio?" | summarises title, sections, products |
| "click add to cart" | "haz clic en añadir al carrito" | ring on target, 1s cancellable pause, real DOM click, read-back receipt |
| "find headphones" / "next" | "busca auriculares" / "siguiente" | highlights matches, steps through them |
| "read this" / "read the returns section" | "lee esto" / "lee la sección de envíos" | reads on-screen text or a section |
| "stop" / "close" | "para" / "cierra" | stops everything / closes (mic released) |
| "scroll down", "go to the top", "help", "yes/no", "the second one" | "baja", "ve arriba", "ayuda", "sí/no", "el segundo" | |

Ambiguity ("add to cart" with 4 matches) produces a numbered list with rings and badges; answer with a number, ordinal or name.
Anything that looks like a purchase / delete / submit asks for a spoken or typed **yes** first. Password and payment forms are never touched.

## 2b. Glass mode: the visual is the product (v0.3)

One pane of frosted glass over the whole page, like glass over a monitor: the site stays visible behind it,
a glowing circle sits in the middle, and radial waves around it move with **your voice** (mic level) and with
**the assistant's voice** (its audio level). The site underneath is only a backdrop; the same layer works over any page.

```html
<script>
  window.VoiceLayerConfig = {
    mode: 'glass',
    glass: { blur: 14, tint: 0.22, hue: 215, lite: 'auto', passThrough: true,
             visual: 'line', flow: 'out' },
    companion: { preset: 'training', name: 'Alex', demo: true }   // demo:true = fake data, announced as DEMO
  };
</script>
<script src="/voicelayer/voicelayer.js" defer></script>
```

Visitor experience: the glass is up, the circle breathes, **"Tap to start"**. One tap = the assistant speaks first
(greeting, then its question or what it noticed), then the mic opens. Browsers do not allow audio or the mic before
a tap, so that single tap is the only gate and it is deliberate: asleep means no mic and no voice.

- **The visual**: a glass orb with a row of rounded dashes under it (`visual: 'line'`, the default). Asleep, the dashes sit flat and breathe. When the greeting starts, the dashes grow at the centre and the wave travels outward to both ends as the words are spoken; the same line moves with the visitor's voice while listening. `flow: 'right'` makes it travel left to right instead. `visual: 'radial'` (bars around the orb) and `'both'` are still available.
- **Page stays usable**: clicks, scroll and keys reach the page behind the glass (`passThrough`). Only the circle and controls capture input.
- **Voice controls everything**: "next", "skip", "why", "repeat", "yes/no", "mute/unmute", "pause" (back to tap-to-start), "minimize", "turn off", "English/Español", plus every page command from section 2.
- **Always visible controls**: pause, mute, minimize, turn off, typed input. Esc closes.
- **Cost control**: `lite: 'auto'` measures frame time and drops to fewer bars and no backdrop blur on weak devices.
- **Accessibility**: `prefers-reduced-motion` calms the waves; every state is also in captions; the circle has an accessible name.
- Demo: `/voicelayer/demo-glass` with `?preset=wellness|training|coaching|support|none&lang=es&blur=14&tint=0.22&hue=215&lite=false&debug=true`.

## 2c. Companion: what the assistant says first (any intent)

Rule-based, no LLM. Presets: `wellness`, `training`, `coaching`, `support`, `none` (plain voice commander).
Flow: wake tap, greeting, mood question, "I have N things to share", one card per insight (next / skip / why / repeat),
an optional approved offer (yes / no), wrap-up. Say "summary" any time to start again.

```js
companion: {
  preset: 'training', name: 'Alex',
  signals: async () => (await fetch('/api/me/signals')).json(),   // object | function | Promise | signalsUrl | VoiceLayer.setSignals(obj)
  rules:   [{ id: 'rest', pri: 80, kind: 'nudge', when: { metric: 'recovery', op: '<', value: 40 },
              text: { en: 'Your {label} is {value}{unit}. A lighter session may suit today.', es: '...' },
              because: { en: 'Recovery was below 40.', es: '...' } }],
  catalog: [{ id: 'mat', name: { en: 'a yoga mat', es: 'una esterilla' }, for: ['recovery'], approved: true, rx: false }],
  disclosure: { en: 'This is a product suggestion, not advice.', es: '...' },
  maxInsights: 3, maxAgeHours: 48
}
```

Signals shape: `{ name, metrics: { key: { value, prev, target, unit, label, at, ref:{low,high}, lab, ttlHours, source } }, tasks: [{ id, kind, label, due, done }] }`.
`when` forms: `{metric, op, value}` · `{metric, change:{op,value}}` · `{metric, belowTarget:true}` · `{metric:'*', lab:true, outOfRange:true}` · `{task:{kind}, pending:true}` · a function.
Text tokens: `{label} {value} {unit} {prev} {change} {target} {low} {high} {date} {source} {name} {pct} {dueAt}`.
Add your own intent by writing rules; nothing in the engine is wellness-specific.

**Guardrails that cannot be configured away**
- Observations only: rule text with diagnose/instruct wording is dropped at load (`CP_LINT`).
- Only catalog items with `approved: true` are offered, always with a non-empty disclosure and a "why am I seeing this".
- `rx: true` items are never offered or sold; the visitor is routed to their provider.
- Crisis phrases (EN/ES) get a safety message only, nothing else runs.
- "No suggestions" turns offers off for that visitor (remembered).
- Stale data is never presented (default 48 h; labs use their own `ttlHours`).
- Demo data is badged "DEMO DATA" and announced out loud.
- Events carry rule and item ids only, never raw health or personal values.

Events: `voicelayer:companion` (`greeted | mood | insight | offer_shown | offer_accepted | rx_routed | opt_out | safety | welcome_back`), `voicelayer:offer`, `voicelayer:glass` (`open | closed | awake | asleep`).
API additions: `wake() pause() awake setSignals(obj) companion{enabled,preset,stage,insights,rules}`.

**Legal note (not legal advice):** health, supplement, peptide and coaching claims, consent for health data, and voice/biometric
rules differ by country and state. The assistant is built to inform, never to diagnose or treat, but you need your own counsel and
privacy policy (including the speech engine you enable) before real data or real offers go live.

## 3. Visitor control (always)

- The **microphone only turns on when the visitor taps** (orb, mic button, language button, or the greeting bubble then mic). Never on page load.
- **STOP** (red button / "stop" / Esc) halts speech, pending clicks and the mic. Closing the panel also releases the mic. Moving/clicking/typing on the page during the 1s pre-click pause cancels the click.
- **Minimize** folds the orb into a small edge tab (remembered). **Turn off voice help** hides everything (remembered on this device).
- **Bring it back:** `<a href="#" data-voicelayer-open>Voice help</a>` on your page, hotkey `Alt+Shift+V`, `?voicelayer=on` in the URL, the edge tab, or `VoiceLayer.show()`.
- **Greeting bubble:** one small, silent, dismissible hint per browser session after 4s of inactivity. Tapping it opens the panel; the mic stays off.

## 4. Owner kill switch

- Static: `window.VoiceLayerConfig = { enabled: false }` (or remove the script tag).
- Server: set `VOICELAYER_ENABLED=false` on the API; every widget on every site calls `/api/voice/config`, removes itself and releases the mic.
  It is checked on page load and again every time the panel opens. If the config endpoint is unreachable the widget **fails open** (keeps working with browser voice). This is a deliberate choice; tell me if you want fail-closed.

## 5. Better voice with Deepgram (optional)

| | Browser engine (default) | Deepgram engine |
|---|---|---|
| Speech-to-text | `SpeechRecognition` (Chrome/Edge/Safari; Chrome sends audio to Google) | Nova-3 streaming, `en` / `es` / `es-419` |
| Text-to-speech | `speechSynthesis` (voice depends on device) | Aura-2 (`aura-2-thalia-en`, `aura-2-celeste-es`) |
| Waveform while speaking | simulated (browsers expose no output audio) | real, from the audio output |
| Firefox | typed input only | should work (plain WebSocket + AudioWorklet), not tested |

Server routes (Hono, `src/index.tsx`):

| Route | Purpose |
|---|---|
| `GET /api/voice/config` | `{enabled, deepgram, voices…}`; no secrets |
| `POST /api/voice/token` | mints a 60-second Deepgram JWT; the widget connects straight to Deepgram with it |
| `GET /api/voice/listen` | WebSocket proxy (automatic fallback if the direct connection is refused) |
| `POST /api/voice/speak` | text (≤700 chars) → Aura-2 mp3 |

Setup:

```bash
# local: put the key in /home/user/webapp/.dev.vars (gitignored)
DEEPGRAM_API_KEY=xxxxxxxx        # Deepgram key with "Member" permission (needed to mint temp tokens)
VOICELAYER_ENABLED=true
# production (Cloudflare Pages)
npx wrangler pages secret put DEEPGRAM_API_KEY --project-name <project>
# other sites embedding the widget: comma-separated origins
VOICELAYER_ALLOWED_ORIGINS=https://shop.example,https://www.shop.example
```

Safeguards: key only in server env; same-origin or allow-listed origins only (403 otherwise); per-isolate rate limits
(token 20/min, speak 60/min, listen 10/min); whitelisted models/languages/voices; WebSocket sessions capped at 10 minutes.
If Deepgram fails (token, socket, TTS) the widget falls back to the browser engine and tells the visitor. `provider: 'browser'` disables Deepgram entirely.

**Privacy line shown in the panel:** browser engine: "the speech service of your browser (in Chrome, Google's) transcribes; nothing is sent to this site".
Deepgram engine: "while the mic is on, your voice is sent to Deepgram for transcription and spoken replies are generated by Deepgram. This widget stores no audio."
Your own privacy policy must mention whichever engine you enable.

## 6. Language

`language: 'auto'` resolves: visitor's saved choice > `config.language` > `<html lang>` > browser language > English.
A switcher (EN / ES) sits in the panel footer; switching restarts listening in the new language (the click is the user gesture) and is remembered.
Change any UI text per language: `text: { es: { title: 'Asistente', placeholder: '...' } }`. Add a language by adding a pack to `PACKS` (UI, grammar, messages).

## 7. Events and API

Events (on `window`): `voicelayer:sitemap | state | command | receipt | language`.
`window.VoiceLayer`: `open() close() stop() say(text) run(text) minimize() turnOff() show() setLanguage(code) language engine mode state getSiteMap() rescan() receipts config`.

Every action produces a receipt `{action,label,status,verification:'read_back'|'none',verified,at}` with the rule
`verified === (verification === 'read_back')`. "Verified" only when the page was read back after the action (cart counter changed, section landed in view).
Otherwise the assistant says it could not confirm, never "done".

## 8. Honest limitations

- Clicks are synthetic DOM events (`isTrusted=false`). Sites that demand trusted gestures (some payment/consent widgets, `window.open` popups) can ignore them.
- Cross-origin iframes and closed shadow roots on the host page are not scanned or clicked.
- No form filling and no multi-step flows by design in Phase 0.
- Grammar is rule-based: it understands the command shapes above, not free conversation. Fuzzy matching tolerates small mis-hearings.
- Page names and button labels are matched in the page's own language; saying a Spanish command on an English page works only when the words are similar.
- Browser TTS can't be measured by the page, so with browser voices the line is a speech-shaped simulation (it starts and stops with the audio and kicks on word boundaries). With Deepgram voice the line follows the real audio level.
- Glass: `backdrop-filter` is GPU work. `lite:'auto'` reacts to slow frames, but it is only measured on this sandbox, not on low-end phones.
- Speak-first needs one tap (browser rule). It cannot be removed.
- Companion insights are only as good as the signals you feed it; demo data is fake by design.
- Not yet measured on real hardware: Chrome's real `SpeechRecognition` accuracy, real mic levels, Safari/iOS behaviour, a real Deepgram session (tests use a mock; see SELF-TEST.md).

## 9. Files

`voicelayer.js` · `voicelayer.css` · `demo.html` (EN store) · `demo-es.html` (ES store) · `demo-glass.html` (glass + companion) · `embed-snippet.html` · `SELF-TEST.md`
Demo URLs when the project runs: `/voicelayer/demo`, `/voicelayer/demo-es`, `/voicelayer/demo-glass`.

## 10. Skills (v0.4, all opt-in, default off)

| Option | What it does |
|---|---|
| `forms: true` | "change my phone to 305 555 0199": finds the field, reads it back, asks yes/no, fills, then re-reads the DOM to verify. Refuses password/payment/ID fields (value redacted in transcript and events). Never submits by itself. "undo that" restores. |
| `memory: true` or `{ttlDays:180, maxPages:8, maxFacts:10, pages:true, skipPaths:[]}` | Consent-gated, device-local (localStorage). "remember me", "my name is...", "what do you remember", "stop remembering", "forget me". Welcome-back on a later visit. Refuses health/payment notes. No server storage. |
| `knowledge: true` or `{pages:[], facts:[{q,a,source,url,keywords}], minScore:0.55}` | Answers from the site's own text (this page, listed pages, owner facts) and names the source. No match: says so, never guesses. Medical-advice questions go to a professional. Keyword matching, not an LLM. |
| `voiceGender: 'female'` (default) / `'male'` / `'any'`, `voiceName` | Browser-voice preference. Gender is a voice-name heuristic (browsers do not publish it). |

Server voices: defaults `aura-2-athena-en` and `aura-2-selena-es`. Override with env `VOICELAYER_VOICE_EN` / `VOICELAYER_VOICE_ES` (must match `aura-2-<name>-en|es`, otherwise ignored).

Events: `voicelayer:memory`, `voicelayer:knowledge`. Demo pages: `demo-account.html`, `demo-account-policies.html`.

Honest limits: the female voice is not audibly verified without a Deepgram key. Knowledge is keyword retrieval. Memory is per device. Forms handle text, email, tel, textarea and select only (not date, checkbox, radio, file).

## 11. Spatial Intelligence, Live Inventory & Behavioral Learning (v0.5 – v0.6.0)

| Feature | Configuration / API | Voice Commands (EN & ES) |
|---|---|---|
| **Live Inventory & Catalog Engine** | `inventory: { autoScan: true, items: [...], url: '/api/catalog' }`, `VoiceLayer.setInventory([...])`, `VoiceLayer.inventory.query({ maxPrice, category, inStockOnly, sort })` | *"What's in stock?"*, *"How much is Aurora One?"*, *"Show items under $80"*, *"What's the cheapest item?"*, *"Compare Aurora One and Pulse Earbuds"* / *"¿Qué hay en stock?"*, *"¿Cuánto cuesta…?"*, *"Artículos por menos de 80"* |
| **Live Cart Awareness** | Automatic DOM counter scan (`[data-cart-count]`) + `VoiceLayer.setCart({ count, total, items })` | *"What's in my cart?"*, *"Cart total"* / *"¿Qué hay en mi carrito?"* |
| **Spatial & Deictic ("This") Awareness** | `behavior: { enabled: true, dwellMs: 1200 }`, `VoiceLayer.behavior.snapshot`, `VoiceLayer.behavior.activeProduct` | *"Where am I?"*, *"What am I looking at?"*, *"How much is this?"*, *"Is this in stock?"*, *"Add this to cart"*, *"What have I looked at?"* / *"¿Dónde estoy?"*, *"¿Qué estoy viendo?"*, *"¿Cuánto cuesta esto?"*, *"Añade esto al carrito"* |
| **User Profile & Goal Recommendations** | `profile: { name, tier, goals, preferences }`, `VoiceLayer.setProfile({...})`, `VoiceLayer.profile.addGoal('sleep')` | *"I'm looking for wireless headphones"*, *"My goal is better battery"*, *"What do you recommend for me?"*, *"What is my profile?"* / *"Busco auriculares inalámbricos"*, *"¿Qué me recomiendas?"* |
| **Custom Host Actions** | `actions: [{ id, label, phrases: [...], confirm: false, handler: (ctx) => '...' }]`, `VoiceLayer.registerAction({...})` | Matches any phrase registered by the host site; optional yes/no confirmation ceremony before execution. |
| **Context-Rich AI Brain (`aiAnswer`)** | `aiAnswer: async (question, ctx) => ({ text, action: { type: 'go'|'click'|'highlight', target } })` | Receives full `ctx` (`language`, `page`, `spatial`, `inventory`, `cart`, `profile`, `companion`), lints reply against `CP_LINT`, and optionally triggers a safe page action. |
| **Top-Dock Glass (`dock: 'top'`)** | `glass: { dock: 'top', height: 0.42 }` | Renders a 1:1 readable top-docked glass header bar with a live spatial context pill (`Section · Active Product`) and proportional voice-reactive circle. |

