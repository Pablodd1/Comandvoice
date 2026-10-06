# VoiceLayer (Phase 0 spike, v0.2.0)

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
- Browser TTS can't be measured by the page, so the speaking waveform is simulated with browser voices.
- Not yet measured on real hardware: Chrome's real `SpeechRecognition` accuracy, real mic levels, Safari/iOS behaviour, a real Deepgram session (tests use a mock; see SELF-TEST.md).

## 9. Files

`voicelayer.js` · `voicelayer.css` · `demo.html` (EN store) · `demo-es.html` (ES store) · `embed-snippet.html` · `SELF-TEST.md`
Demo URLs when the project runs: `/voicelayer/demo`, `/voicelayer/demo-es`.
