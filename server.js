/**
 * Bharat Nova AI — /api/server (Vercel Edge Function)
 * ─────────────────────────────────────────────────────
 * 7-ENGINE ARCHITECTURE WITH AUTOMATIC FAILSAFE FALLBACK
 *
 * The client sends ONE request with a chosen "engine".
 * The server tries that engine first. If it fails (rate
 * limit, bad key, timeout, outage) it AUTOMATICALLY tries
 * the next-best engine from FALLBACK_ORDER, and the next,
 * until one succeeds (max 3 attempts to stay inside
 * Vercel's edge time budget). The response tells the
 * client exactly what happened so the UI can show a
 * "System: X failed → answered via Y" toast.
 *
 * ───────────────────────────────────────────────────────
 * ⚠️  MODEL NOTE (read before deploying):
 * A few model IDs requested in the original spec are now
 * dead on free tiers as of June 2026, so they were swapped
 * for the closest live/stable/lightweight replacement:
 *   - Gemini:   gemini-1.5-flash is FULLY SHUT DOWN (404 on
 *               all calls). Using gemini-2.5-flash instead.
 *   - Groq:     llama3-8b-8192 was decommissioned in 2025,
 *               and its successor llama-3.1-8b-instant was
 *               ALSO deprecated on 2026-06-17. Using Groq's
 *               own recommended replacement: openai/gpt-oss-20b.
 *   - OpenRouter: specific ":free" 8B slugs rotate/disappear
 *               constantly. Using "openrouter/free", their
 *               official auto-router across free models —
 *               far more stable for a free-tier app.
 *   - Fireworks: "llama-v3-8b-instruct" doesn't exist; the
 *               correct current ID is llama-v3p1-8b-instruct.
 *   - NVIDIA:   "meta/llama3-8b-instruct" still resolves, but
 *               the actively maintained slug is
 *               meta/llama-3.1-8b-instruct — used here.
 *   - HuggingFace & Cohere model IDs from the spec are intact.
 * All 7 are still small/fast/free-tier-safe as requested.
 * ───────────────────────────────────────────────────────
 *
 * ENV VARS (Vercel → Project → Settings → Environment Variables):
 *   GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY,
 *   HUGGINGFACE_API_KEY, COHERE_API_KEY, FIREWORKS_API_KEY,
 *   NVIDIA_API_KEY
 */

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PROVIDER_TIMEOUT_MS = 12000; // keep each attempt short so fallback chain fits in edge time budget
const MAX_ATTEMPTS = 3;            // selected engine + up to 2 automatic fallbacks

async function fetchWithTimeout(url, options) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* Normalize message content to a plain string — every engine here is
   text-only, and resending full history every turn means any stray
   non-string content would break a provider on every later turn too. */
function flattenMessages(messages) {
  return (messages || [])
    .filter(m => m && m.role && m.content != null)
    .map(m => ({ role: m.role, content: String(m.content) }));
}

async function readErrorDetail(res) {
  try { return (await res.text()).slice(0, 220); } catch { return ''; }
}

/* ════════════════════════════════════════════════════
   GENERIC OpenAI-COMPATIBLE CALLER
   Covers Groq, OpenRouter, Fireworks, NVIDIA NIM, and
   HuggingFace's router — they all speak the same
   /chat/completions shape.
════════════════════════════════════════════════════ */
async function callOpenAICompatible({ url, apiKey, model, messages, temperature, max_tokens, extraHeaders, label }) {
  if (!apiKey) {
    throw new Error(`${label}: API key not set on the server (check Vercel env vars).`);
  }
  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...(extraHeaders || {}),
      },
      body: JSON.stringify({
        model,
        messages: flattenMessages(messages),
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 1024,
        stream: false,
      }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${label}: timed out after ${PROVIDER_TIMEOUT_MS / 1000}s.`);
    throw new Error(`${label}: request failed (${err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`${label}: HTTP ${res.status} — ${detail || 'request failed'}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !content.trim()) throw new Error(`${label}: returned an empty response.`);
  return content.trim();
}

/* ════════════════════════════════════════════════════
   GOOGLE GEMINI — native REST generateContent API
════════════════════════════════════════════════════ */
async function callGemini(messages, temperature, max_tokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('Gemini: API key not set on the server.');

  let systemText = '';
  const contents = [];
  for (const m of flattenMessages(messages)) {
    if (m.role === 'system') { systemText += m.content + '\n'; continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  if (!contents.length) throw new Error('Gemini: no readable message content.');

  const body = {
    contents,
    generationConfig: {
      temperature: temperature !== undefined ? temperature : 0.7,
      maxOutputTokens: max_tokens || 1024,
    },
    ...(systemText.trim() ? { systemInstruction: { parts: [{ text: systemText.trim() }] } } : {}),
  };

  let res;
  try {
    res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Gemini: timed out after ${PROVIDER_TIMEOUT_MS / 1000}s.`);
    throw new Error(`Gemini: request failed (${err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Gemini: HTTP ${res.status} — ${detail || 'request failed'}`);
  }

  const data = await res.json();
  if (data?.promptFeedback?.blockReason) {
    throw new Error(`Gemini: response blocked (${data.promptFeedback.blockReason}).`);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini: returned an empty response.');
  return text;
}

/* ════════════════════════════════════════════════════
   COHERE — v2 Chat API
════════════════════════════════════════════════════ */
async function callCohere(messages, temperature, max_tokens) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error('Cohere: API key not set on the server.');

  let res;
  try {
    res = await fetchWithTimeout('https://api.cohere.com/v2/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'command-r-08-2024',
        messages: flattenMessages(messages),
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 1024,
      }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Cohere: timed out after ${PROVIDER_TIMEOUT_MS / 1000}s.`);
    throw new Error(`Cohere: request failed (${err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Cohere: HTTP ${res.status} — ${detail || 'request failed'}`);
  }

  const data = await res.json();
  const text = (data?.message?.content || [])
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('')
    .trim();
  if (!text) throw new Error('Cohere: returned an empty response.');
  return text;
}

/* ════════════════════════════════════════════════════
   PROVIDER REGISTRY
════════════════════════════════════════════════════ */
const PROVIDERS = {
  gemini: {
    name: 'Gemini',
    call: (messages, temperature, max_tokens) => callGemini(messages, temperature, max_tokens),
  },
  groq: {
    name: 'Groq',
    call: (messages, temperature, max_tokens) => callOpenAICompatible({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY,
      model: 'openai/gpt-oss-20b',
      messages, temperature, max_tokens,
      label: 'Groq',
    }),
  },
  openrouter: {
    name: 'OpenRouter',
    call: (messages, temperature, max_tokens) => callOpenAICompatible({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY,
      model: 'openrouter/free',
      messages, temperature, max_tokens,
      extraHeaders: { 'HTTP-Referer': 'https://bharat-nova-ai.vercel.app', 'X-Title': 'Bharat Nova AI' },
      label: 'OpenRouter',
    }),
  },
  cohere: {
    name: 'Cohere',
    call: (messages, temperature, max_tokens) => callCohere(messages, temperature, max_tokens),
  },
  fireworks: {
    name: 'Fireworks',
    call: (messages, temperature, max_tokens) => callOpenAICompatible({
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      apiKey: process.env.FIREWORKS_API_KEY,
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      messages, temperature, max_tokens,
      label: 'Fireworks',
    }),
  },
  nvidia: {
    name: 'NVIDIA',
    call: (messages, temperature, max_tokens) => callOpenAICompatible({
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      apiKey: process.env.NVIDIA_API_KEY,
      model: 'meta/llama-3.1-8b-instruct',
      messages, temperature, max_tokens,
      label: 'NVIDIA',
    }),
  },
  huggingface: {
    name: 'HuggingFace',
    call: (messages, temperature, max_tokens) => callOpenAICompatible({
      url: 'https://router.huggingface.co/v1/chat/completions',
      apiKey: process.env.HUGGINGFACE_API_KEY,
      model: 'meta-llama/Llama-3.1-8B-Instruct',
      messages, temperature, max_tokens,
      label: 'HuggingFace',
    }),
  },
};

/* Order used to pick automatic fallbacks. Fastest / most reliable
   free-tier engines first; HuggingFace last since shared serverless
   free inference is the most rate-limited of the seven. */
const FALLBACK_ORDER = ['gemini', 'groq', 'cohere', 'openrouter', 'fireworks', 'nvidia', 'huggingface'];

/* ════════════════════════════════════════════════════
   MAIN HANDLER
════════════════════════════════════════════════════ */
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: { message: 'Method not allowed' } }),
      { status: 405, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: { message: 'Invalid JSON body' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  const { messages, temperature, max_tokens } = body || {};
  const requestedEngine = PROVIDERS[body?.engine] ? body.engine : 'groq';

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required field: messages (array)' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  // Try the requested engine first, then automatic fallbacks, in order.
  const attemptOrder = [requestedEngine, ...FALLBACK_ORDER.filter(k => k !== requestedEngine)].slice(0, MAX_ATTEMPTS);
  const errors = {};

  for (let i = 0; i < attemptOrder.length; i++) {
    const key = attemptOrder[i];
    try {
      const reply = await PROVIDERS[key].call(messages, temperature, max_tokens);
      return new Response(
        JSON.stringify({
          reply,
          engine: key,
          engineName: PROVIDERS[key].name,
          requestedEngine,
          requestedEngineName: PROVIDERS[requestedEngine].name,
          fallback: key !== requestedEngine,
          triedEngines: attemptOrder.slice(0, i + 1),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS_HEADERS } }
      );
    } catch (err) {
      errors[key] = err?.message || 'Unknown error';
      continue; // automatic failsafe — try the next engine
    }
  }

  // Every attempted engine failed.
  return new Response(
    JSON.stringify({
      error: true,
      message: 'All attempted engines failed. They may be rate-limited or the keys may be missing.',
      requestedEngine,
      triedEngines: attemptOrder,
      details: errors,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS_HEADERS } }
  );
}
