import { Hono } from 'hono'
import type { Context } from 'hono'

/**
 * VoiceLayer server routes (Deepgram bridge).
 *
 *   GET  /api/voice/config   public flags: is the widget enabled (owner kill switch), is Deepgram available
 *   POST /api/voice/token    mints a short-lived Deepgram access token (JWT) for direct browser -> Deepgram streaming
 *   GET  /api/voice/listen   WebSocket proxy to Deepgram /v1/listen (fallback when the browser can't connect directly)
 *   POST /api/voice/speak    text -> speech (Aura-2) as audio/mpeg
 *
 * The Deepgram API key lives ONLY in the server environment (.dev.vars locally, `wrangler secret` in production).
 * The model never chooses security-relevant values: voices, models, limits and origins are decided here.
 */
type Bindings = {
  DEEPGRAM_API_KEY?: string
  VOICELAYER_ENABLED?: string          // "false" = owner kill switch: every widget on every site turns itself off
  VOICELAYER_ALLOWED_ORIGINS?: string  // comma-separated extra origins allowed to call these routes (same-origin is always allowed)
  VOICELAYER_ALLOW_ANY_ORIGIN?: string // "true" only for local testing
}

declare const WebSocketPair: any

const app = new Hono<{ Bindings: Bindings }>()

const DG = 'https://api.deepgram.com'
const MAX_TTS_CHARS = 700
const MAX_LISTEN_MS = 10 * 60 * 1000
const VOICES: Record<string, string> = { en: 'aura-2-thalia-en', es: 'aura-2-celeste-es' }
const VOICE_RE = /^aura-2-[a-z]+-(en|es)$/
const LISTEN_PARAMS = new Set([
  'model', 'language', 'interim_results', 'smart_format', 'punctuate', 'endpointing', 'utterance_end_ms',
  'vad_events', 'encoding', 'sample_rate', 'channels', 'keyterm'
])
const LISTEN_MODELS = new Set(['nova-3'])
const LISTEN_LANGS = new Set(['en', 'es', 'es-419'])

/* ------------------------------------------------------------------ origin + CORS + rate limit */
function allowedOrigin(c: Context<{ Bindings: Bindings }>): string | null {
  const origin = c.req.header('origin')
  if (!origin) return null
  const env = c.env || {}
  if (env.VOICELAYER_ALLOW_ANY_ORIGIN === 'true') return origin
  try {
    const o = new URL(origin)
    if (o.host === new URL(c.req.url).host) return origin
  } catch { return null }
  const list = (env.VOICELAYER_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean)
  return list.includes(origin.replace(/\/+$/, '')) ? origin : null
}

// best-effort per-isolate limiter (resets when the isolate recycles) — protects the key from casual abuse, not from a determined attacker
const hits = new Map<string, number[]>()
function limited(c: Context<{ Bindings: Bindings }>, bucket: string, max: number, windowMs = 60_000): boolean {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'local'
  const k = bucket + ':' + ip, now = Date.now()
  const arr = (hits.get(k) || []).filter((t) => now - t < windowMs)
  if (arr.length >= max) { hits.set(k, arr); return true }
  arr.push(now); hits.set(k, arr)
  if (hits.size > 5000) { for (const [kk, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(kk) }
  return false
}

app.use('/api/voice/*', async (c, next) => {
  const origin = c.req.header('origin')
  const ok = allowedOrigin(c)
  if (c.req.method === 'OPTIONS') {
    if (!ok) return c.body(null, 403)
    return c.body(null, 204, {
      'access-control-allow-origin': ok, 'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type', 'access-control-max-age': '600', vary: 'origin'
    })
  }
  // /config is harmless (two booleans) and may be read from anywhere; everything else needs an allowed Origin
  if (c.req.path !== '/api/voice/config' && !ok) {
    return c.json({ error: 'origin_not_allowed', hint: origin ? 'add this origin to VOICELAYER_ALLOWED_ORIGINS' : 'Origin header required' }, 403)
  }
  await next()
  if (ok) { c.res.headers.set('access-control-allow-origin', ok); c.res.headers.append('vary', 'origin') }
})

const enabled = (c: Context<{ Bindings: Bindings }>) => (c.env?.VOICELAYER_ENABLED ?? 'true').toLowerCase() !== 'false'
const hasKey = (c: Context<{ Bindings: Bindings }>) => !!(c.env?.DEEPGRAM_API_KEY && c.env.DEEPGRAM_API_KEY.length > 10)

/* ------------------------------------------------------------------ routes */
app.get('/api/voice/config', (c) => {
  c.header('cache-control', 'no-store')
  return c.json({
    enabled: enabled(c),
    deepgram: enabled(c) && hasKey(c),
    stt: 'deepgram-nova-3', tts: 'deepgram-aura-2', languages: ['en', 'es'],
    voices: VOICES
  })
})

app.post('/api/voice/token', async (c) => {
  if (!enabled(c)) return c.json({ error: 'disabled' }, 403)
  if (!hasKey(c)) return c.json({ error: 'not_configured' }, 503)
  if (limited(c, 'token', 20)) return c.json({ error: 'rate_limited' }, 429)
  const r = await fetch(`${DG}/v1/auth/grant`, {
    method: 'POST',
    headers: { Authorization: `Token ${c.env.DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl_seconds: 60 })
  })
  if (!r.ok) {
    // never forward Deepgram's body (could echo account details); log status only
    console.warn('deepgram auth/grant failed', r.status)
    return c.json({ error: 'upstream', status: r.status, hint: r.status === 403 ? 'API key needs Member permission to mint temporary tokens' : undefined }, 502)
  }
  const j = (await r.json()) as { access_token?: string; expires_in?: number }
  c.header('cache-control', 'no-store')
  return c.json({ token: j.access_token, expiresIn: j.expires_in ?? 60, listenUrl: 'wss://api.deepgram.com/v1/listen', proxy: true })
})

app.post('/api/voice/speak', async (c) => {
  if (!enabled(c)) return c.json({ error: 'disabled' }, 403)
  if (!hasKey(c)) return c.json({ error: 'not_configured' }, 503)
  if (limited(c, 'speak', 60)) return c.json({ error: 'rate_limited' }, 429)
  let body: { text?: string; lang?: string; voice?: string } = {}
  try { body = await c.req.json() } catch { return c.json({ error: 'bad_json' }, 400) }
  const text = String(body.text || '').replace(/\s+/g, ' ').trim()
  if (!text) return c.json({ error: 'empty' }, 400)
  if (text.length > MAX_TTS_CHARS) return c.json({ error: 'too_long', max: MAX_TTS_CHARS }, 413)
  const lang = body.lang === 'es' ? 'es' : 'en'
  const voice = body.voice && VOICE_RE.test(body.voice) && body.voice.endsWith('-' + lang) ? body.voice : VOICES[lang]
  const r = await fetch(`${DG}/v1/speak?model=${voice}&encoding=mp3`, {
    method: 'POST',
    headers: { Authorization: `Token ${c.env.DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text })
  })
  if (!r.ok || !r.body) { console.warn('deepgram speak failed', r.status); return c.json({ error: 'upstream', status: r.status }, 502) }
  return new Response(r.body, { headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' } })
})

app.get('/api/voice/listen', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: 'websocket_required' }, 426)
  if (!enabled(c)) return c.json({ error: 'disabled' }, 403)
  if (!hasKey(c)) return c.json({ error: 'not_configured' }, 503)
  if (limited(c, 'listen', 10)) return c.json({ error: 'rate_limited' }, 429)

  // forward only whitelisted, validated query params
  const src = new URL(c.req.url).searchParams, out = new URLSearchParams()
  src.forEach((v, k) => { if (LISTEN_PARAMS.has(k) && v.length < 64) out.append(k, v) })
  if (!LISTEN_MODELS.has(out.get('model') || '')) out.set('model', 'nova-3')
  if (!LISTEN_LANGS.has(out.get('language') || '')) out.set('language', 'en')

  const up = await fetch(`${DG}/v1/listen?${out.toString()}`, {
    headers: { Upgrade: 'websocket', Authorization: `Token ${c.env.DEEPGRAM_API_KEY}` }
  })
  const upstream = (up as any).webSocket
  if (!upstream) { console.warn('deepgram listen upgrade failed', up.status); return c.json({ error: 'upstream', status: up.status }, 502) }
  upstream.accept()
  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair) as any[]
  server.accept()

  const kill = () => { try { server.close(1000, 'done') } catch {} try { upstream.close(1000, 'done') } catch {} }
  const timer = setTimeout(kill, MAX_LISTEN_MS)
  server.addEventListener('message', (e: any) => { try { upstream.send(e.data) } catch { kill() } })
  upstream.addEventListener('message', (e: any) => { try { server.send(e.data) } catch { kill() } })
  server.addEventListener('close', () => { clearTimeout(timer); try { upstream.close(1000) } catch {} })
  upstream.addEventListener('close', () => { clearTimeout(timer); try { server.close(1000) } catch {} })
  server.addEventListener('error', kill)
  upstream.addEventListener('error', kill)
  return new Response(null, { status: 101, webSocket: client } as any)
})

app.get('/', (c) => c.redirect('/voicelayer/demo'))

export default app
