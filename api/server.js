/**
 * Bharat Nova AI — /api/server (Vercel Edge Function)
 * ─────────────────────────────────────────────────────
 * 10-ENGINE ARCHITECTURE WITH AUTOMATIC FAILSAFE FALLBACK
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
 * VISION SUPPORT:
 *   Gemini        — native multimodal via generateContent API
 *   Mistral       — text via open-mistral-7b;
 *                   vision via pixtral-12b-2409
 *   GitHub Models — gpt-4o-mini natively accepts image_url
 *                   content blocks (OpenAI-compatible vision)
 *   SambaNova     — text via Meta-Llama-3.3-70B-Instruct;
 *                   vision via Llama-4-Maverick-17B-128E-Instruct
 * All other engines (OpenRouter, Groq, Cohere, Fireworks,
 * NVIDIA, HuggingFace) are text-only. If a non-vision
 * engine is selected with an image attached, the backend
 * automatically redirects the request to Gemini.
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
 *   - GitHub Models: openai/gpt-4o-mini via the official
 *               https://models.github.ai/inference/chat/completions
 *               endpoint, authenticated with a GitHub PAT/
 *               GITHUB_TOKEN that has "models: read" scope.
 *   - SambaNova: Meta-Llama-3.3-70B-Instruct for text;
 *               Llama-4-Maverick-17B-128E-Instruct (vision)
 *               when an image is attached, via SambaNova
 *               Cloud's OpenAI-compatible /v1/chat/completions.
 * All 10 are still small/fast/free-tier-safe as requested.
 * ───────────────────────────────────────────────────────
 *
 * ENV VARS (Vercel → Project → Settings → Environment Variables):
 *   GEMINI_API_KEY, GEMINI_API_KEY_2,
 *   GROQ_API_KEY, OPENROUTER_API_KEY,
 *   HUGGINGFACE_API_KEY, COHERE_API_KEY,
 *   FIREWORKS_API_KEY, NVIDIA_API_KEY,
 *   MISTRAL_API_KEY, GITHUB_TOKEN, SAMBANOVA_API_KEY
 */

export const config = { runtime: 'edge' };

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const PROVIDER_TIMEOUT_MS = 9000;  // default per-attempt cap
const TOTAL_BUDGET_MS = 22000;     // whole-request budget so the edge function never hangs even if every engine is tried
const MIN_REMAINING_MS = 1800;     // stop trying more engines once less than this remains

async function fetchWithTimeout(url, options, timeoutMs = PROVIDER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

/* For engines that are text-only (everything except Gemini): if the
   user attached an image/file, we can't send binary content to a
   /chat/completions endpoint that doesn't accept it. Instead of
   crashing or silently dropping it, append a short, clear note to the
   latest user turn so the model answers gracefully and the user knows
   the engine couldn't actually see the attachment. */
function appendAttachmentNote(messages, attachment, label) {
  const flat = flattenMessages(messages);
  if (!flat.length || !attachment) return flat;
  const note = ` [The user also attached a file (${attachment.mimeType}${attachment.name ? `, "${attachment.name}"` : ''}). ${label} is a text-only engine and cannot view attachments — answer using only the text above, and briefly let the user know the file itself couldn't be viewed.]`;
  const last = flat[flat.length - 1];
  flat[flat.length - 1] = { role: last.role, content: last.content + note };
  return flat;
}

/* ════════════════════════════════════════════════════
   GENERIC OpenAI-COMPATIBLE CALLER
   Covers Groq, OpenRouter, Fireworks, NVIDIA NIM, and
   HuggingFace's router — they all speak the same
   /chat/completions shape.
════════════════════════════════════════════════════ */
async function callOpenAICompatible({ url, apiKey, model, visionModel, supportsVision, messages, temperature, max_tokens, extraHeaders, label, timeoutMs, attachment }) {
  if (!apiKey) {
    throw new Error(`${label}: API key not set on the server (check Vercel env vars).`);
  }

  // Vision-capable engines (GitHub Models, SambaNova): if a real image was
  // attached, format it as an OpenAI-style image_url content block on the
  // latest user turn — instead of just leaving a text note — so their
  // vision models can actually "see" the picture. Non-image attachments
  // (or engines without supportsVision) still fall back to the existing
  // text-note behavior so nothing here changes for the original 6 engines.
  const isVisionAttachment = !!(
    supportsVision &&
    attachment && attachment.data && attachment.mimeType &&
    attachment.mimeType.startsWith('image/')
  );

  let outgoingMessages;
  let chosenModel = model;

  if (isVisionAttachment) {
    chosenModel = visionModel || model;
    const flat = flattenMessages(messages);
    const cleanBase64 = String(attachment.data).replace(/^data:[^;]+;base64,/, '');
    outgoingMessages = flat.map((m, idx) => {
      if (idx === flat.length - 1 && m.role === 'user') {
        return {
          role: 'user',
          content: [
            { type: 'text',      text: m.content || 'What is in this image? Describe it in detail.' },
            { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${cleanBase64}` } },
          ],
        };
      }
      return m; // prior turns keep plain { role, content: string }
    });
  } else {
    outgoingMessages = attachment ? appendAttachmentNote(messages, attachment, label) : flattenMessages(messages);
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
        model: chosenModel,
        messages: outgoingMessages,
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 1024,
        stream: false,
      }),
    }, timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`${label}: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
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
   ─────────────────────────────────────────────────
   Key rotation: primary (GEMINI_API_KEY) is tried
   first. On any failure — 429 quota, bad key, network
   error — the error is logged and the EXACT same
   request body is immediately retried with the backup
   key (GEMINI_API_KEY_2). The frontend never sees the
   retry; it only receives the final successful reply.
════════════════════════════════════════════════════ */

/* Low-level helper: fires one HTTP request to Gemini
   with the supplied apiKey and pre-built body object.
   Throws a descriptive Error on any failure so the
   caller can decide whether to retry. */
async function callGeminiWithKey(apiKey, body, timeoutMs) {
  let res;
  try {
    res = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      timeoutMs
    );
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Gemini: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
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

/* Public caller — builds the request body once, then
   delegates to callGeminiWithKey with primary key,
   automatically falling back to the backup key on
   any error before propagating failure to the engine
   loop above. */
async function callGemini(messages, temperature, max_tokens, timeoutMs, attachment) {
  const primaryKey = process.env.GEMINI_API_KEY;
  const backupKey  = process.env.GEMINI_API_KEY_2;

  if (!primaryKey) throw new Error('Gemini: API key not set on the server (GEMINI_API_KEY missing).');

  // ── Build the request body (shared by both key attempts) ──────────
  let systemText = '';
  const contents = [];
  for (const m of flattenMessages(messages)) {
    if (m.role === 'system') { systemText += m.content + '\n'; continue; }
    contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
  }
  if (!contents.length && !attachment) throw new Error('Gemini: no readable message content.');

  // Multimodal attachment: Gemini's generateContent API expects the
  // image/file as an inlineData part inside the relevant "user" turn's
  // parts array (alongside the text part), per the official schema:
  //   { role: 'user', parts: [ { text }, { inlineData: { mimeType, data } } ] }
  // We attach it to the most recent user turn, since that's the turn
  // the file belongs to.
  if (attachment && attachment.data && attachment.mimeType) {
    const cleanData = String(attachment.data).replace(/^data:[^;]+;base64,/, '');
    const inlinePart = { inlineData: { mimeType: attachment.mimeType, data: cleanData } };
    let lastUserIdx = -1;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === 'user') { lastUserIdx = i; break; }
    }
    if (lastUserIdx >= 0) {
      contents[lastUserIdx].parts.push(inlinePart);
    } else {
      contents.push({ role: 'user', parts: [inlinePart] });
    }
  }

  const body = {
    contents,
    generationConfig: {
      temperature: temperature !== undefined ? temperature : 0.7,
      maxOutputTokens: max_tokens || 1024,
    },
    ...(systemText.trim() ? { systemInstruction: { parts: [{ text: systemText.trim() }] } } : {}),
  };

  // ── Attempt 1: primary key ────────────────────────────────────────
  try {
    return await callGeminiWithKey(primaryKey, body, timeoutMs);
  } catch (primaryErr) {
    // If there is no backup key configured, surface the error immediately
    // rather than logging a confusing "switching to backup" message.
    if (!backupKey) throw primaryErr;
    console.log('Primary key failed, switching to backup key...', primaryErr?.message || String(primaryErr));
  }

  // ── Attempt 2: backup key (GEMINI_API_KEY_2) ──────────────────────
  try {
    return await callGeminiWithKey(backupKey, body, timeoutMs);
  } catch (backupErr) {
    // Both keys exhausted — surface a clear combined error message so
    // the engine-level fallback loop above can try the next provider.
    throw new Error(`Gemini: both API keys failed. Last error: ${backupErr?.message || 'unknown'}`);
  }
}

/* ════════════════════════════════════════════════════
   COHERE — v2 Chat API
════════════════════════════════════════════════════ */
async function callCohere(messages, temperature, max_tokens, timeoutMs, attachment) {
  const apiKey = process.env.COHERE_API_KEY;
  if (!apiKey) throw new Error('Cohere: API key not set on the server.');

  const outgoingMessages = attachment ? appendAttachmentNote(messages, attachment, 'Cohere') : flattenMessages(messages);
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
        messages: outgoingMessages,
        temperature: temperature !== undefined ? temperature : 0.7,
        max_tokens: max_tokens || 1024,
      }),
    }, timeoutMs);
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error(`Cohere: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
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
   MISTRAL — Chat + Vision API
   ─────────────────────────────────────────────────
   Text:   open-mistral-7b   (free tier, stable)
   Vision: pixtral-12b-2409  (Mistral's dedicated
           multimodal model, free tier)

   Both paths use the same /v1/chat/completions
   endpoint. `stream: false` is explicit in both
   because Mistral may stream by default on some
   models, which would break res.json() parsing.
   The function is fully self-contained so there
   is no dependency on callOpenAICompatible.
════════════════════════════════════════════════════ */
async function callMistral(messages, temperature, max_tokens, timeoutMs, attachment) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('Mistral: MISTRAL_API_KEY is not set in Vercel environment variables.');

  // Determine if the attachment is a real image that Pixtral can process
  const isVision = !!(
    attachment &&
    attachment.data &&
    attachment.mimeType &&
    attachment.mimeType.startsWith('image/')
  );

  // ── Build the outgoing messages array ───────────────────────────
  const flat = flattenMessages(messages);
  let outgoingMessages;

  if (isVision) {
    // Pixtral expects the final user turn's content as an array:
    //   [{ type: 'text', text: '...' }, { type: 'image_url', image_url: { url: 'data:...' } }]
    // All prior turns keep plain string content — Mistral supports this mixed format.
    const cleanBase64 = String(attachment.data).replace(/^data:[^;]+;base64,/, '');
    outgoingMessages = flat.map((m, idx) => {
      if (idx === flat.length - 1 && m.role === 'user') {
        return {
          role: 'user',
          content: [
            { type: 'text',      text: m.content || 'What is in this image? Describe it in detail.' },
            { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${cleanBase64}` } },
          ],
        };
      }
      return m; // prior turns: plain { role, content: string }
    });
  } else {
    // Text-only: use flat messages. If a non-image file was attached,
    // append a brief note so Mistral acknowledges it can't see the file.
    outgoingMessages = (attachment && !isVision)
      ? appendAttachmentNote(messages, attachment, 'Mistral')
      : flat;
  }

  // ── Choose model based on request type ──────────────────────────
  // open-mistral-7b  — free tier, standard text
  // pixtral-12b-2409 — free tier, Mistral's dedicated vision model
  const model = isVision ? 'pixtral-12b-2409' : 'open-mistral-7b';

  // ── Fire the API request ─────────────────────────────────────────
  let res;
  try {
    res = await fetchWithTimeout(
      'https://api.mistral.ai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: outgoingMessages,
          temperature: temperature !== undefined ? temperature : 0.7,
          max_tokens: max_tokens || 1024,
          stream: false,   // must be explicit — prevents SSE response which breaks res.json()
        }),
      },
      timeoutMs
    );
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error(`Mistral: timed out after ${Math.round((timeoutMs || PROVIDER_TIMEOUT_MS) / 1000)}s.`);
    }
    throw new Error(`Mistral: request failed (${err?.message || 'network error'}).`);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Mistral: HTTP ${res.status} — ${detail || 'request failed'}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content || !String(content).trim()) {
    throw new Error('Mistral: returned an empty response.');
  }
  return String(content).trim();
}

/* ════════════════════════════════════════════════════
   PROVIDER REGISTRY
════════════════════════════════════════════════════ */
const PROVIDERS = {
  gemini: {
    name: 'Gemini',
    vision: true,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callGemini(messages, temperature, max_tokens, timeoutMs, attachment),
  },
  githubmodels: {
    name: 'GitHub Models',
    vision: true, // gpt-4o-mini accepts OpenAI-style image_url content blocks
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://models.github.ai/inference/chat/completions',
      apiKey: process.env.GITHUB_TOKEN,
      model: 'openai/gpt-4o-mini',
      visionModel: 'openai/gpt-4o-mini', // same model handles text + vision natively
      supportsVision: true,
      messages, temperature, max_tokens, timeoutMs, attachment,
      extraHeaders: { 'Accept': 'application/vnd.github+json' },
      label: 'GitHub Models',
    }),
  },
  openrouter: {
    name: 'OpenRouter',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY,
      model: 'openrouter/free',
      messages, temperature, max_tokens, timeoutMs, attachment,
      extraHeaders: { 'HTTP-Referer': 'https://bharat-nova-ai.vercel.app', 'X-Title': 'Bharat Nova AI' },
      label: 'OpenRouter',
    }),
  },
  mistral: {
    name: 'Mistral',
    vision: true,  // text: open-mistral-7b; images: pixtral-12b-2409
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callMistral(messages, temperature, max_tokens, timeoutMs, attachment),
  },
  groq: {
    name: 'Groq',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY,
      model: 'openai/gpt-oss-20b',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'Groq',
    }),
  },
  sambanova: {
    name: 'SambaNova',
    vision: true, // text: Meta-Llama-3.3-70B-Instruct; images: Llama-4-Maverick-17B-128E-Instruct
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.sambanova.ai/v1/chat/completions',
      apiKey: process.env.SAMBANOVA_API_KEY,
      model: 'Meta-Llama-3.3-70B-Instruct',
      visionModel: 'Llama-4-Maverick-17B-128E-Instruct',
      supportsVision: true,
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'SambaNova',
    }),
  },
  nvidia: {
    name: 'NVIDIA',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://integrate.api.nvidia.com/v1/chat/completions',
      apiKey: process.env.NVIDIA_API_KEY,
      model: 'meta/llama-3.1-8b-instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'NVIDIA',
    }),
  },
  huggingface: {
    name: 'HuggingFace',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://router.huggingface.co/v1/chat/completions',
      apiKey: process.env.HUGGINGFACE_API_KEY,
      model: 'meta-llama/Llama-3.1-8B-Instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'HuggingFace',
    }),
  },
  cohere: {
    name: 'Cohere',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callCohere(messages, temperature, max_tokens, timeoutMs, attachment),
  },
  fireworks: {
    name: 'Fireworks',
    vision: false,
    call: (messages, temperature, max_tokens, timeoutMs, attachment) => callOpenAICompatible({
      url: 'https://api.fireworks.ai/inference/v1/chat/completions',
      apiKey: process.env.FIREWORKS_API_KEY,
      model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      messages, temperature, max_tokens, timeoutMs, attachment,
      label: 'Fireworks',
    }),
  },
};

/* Order used to pick automatic fallbacks. Fastest / most reliable
   free-tier, vision-capable engines first; HuggingFace last since shared
   serverless free inference is the most rate-limited of the ten. */
const FALLBACK_ORDER = ['gemini', 'githubmodels', 'groq', 'sambanova', 'cohere', 'openrouter', 'mistral', 'fireworks', 'nvidia', 'huggingface'];

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

  const { messages, temperature, max_tokens, attachment: rawAttachment } = body || {};
  let requestedEngine = PROVIDERS[body?.engine] ? body.engine : 'groq';

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: 'Missing required field: messages (array)' } }),
      { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
    );
  }

  // Normalize + validate an optional image/file attachment. We cap the
  // base64 size generously (~6MB raw) to stay well inside Vercel's edge
  // request-body limits and keep response times fast.
  let attachment = null;
  if (rawAttachment && typeof rawAttachment === 'object' && rawAttachment.data && rawAttachment.mimeType) {
    const data = String(rawAttachment.data);
    if (data.length > 9000000) {
      return new Response(
        JSON.stringify({ error: { message: 'Attachment is too large. Please use a smaller image or file (max ~6MB).' } }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } }
      );
    }
    attachment = {
      data,
      mimeType: String(rawAttachment.mimeType),
      name: rawAttachment.name ? String(rawAttachment.name).slice(0, 120) : '',
    };
  }

  // If a file/image is attached but the user's chosen engine can't see
  // it, automatically lock this request to Gemini (the primary vision-
  // capable engine at the top of FALLBACK_ORDER). Gemini and Mistral
  // both have vision:true so they are never redirected away.
  if (attachment && !PROVIDERS[requestedEngine].vision) {
    requestedEngine = 'gemini';
  }

  // Try the requested engine first, then automatically fall back through
  // the rest of the 7 — bounded by a total time budget (not a fixed
  // attempt count) so it keeps trying engines as long as time allows.
  const attemptOrder = [requestedEngine, ...FALLBACK_ORDER.filter(k => k !== requestedEngine)];
  const errors = {};
  const triedEngines = [];
  const startedAt = Date.now();

  for (let i = 0; i < attemptOrder.length; i++) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < MIN_REMAINING_MS) break; // out of time budget — stop trying more engines

    const key = attemptOrder[i];
    const timeoutMs = Math.min(PROVIDER_TIMEOUT_MS, remaining - 300);
    triedEngines.push(key);

    try {
      const reply = await PROVIDERS[key].call(messages, temperature, max_tokens, timeoutMs, attachment);
      return new Response(
        JSON.stringify({
          reply,
          engine: key,
          engineName: PROVIDERS[key].name,
          requestedEngine,
          requestedEngineName: PROVIDERS[requestedEngine].name,
          fallback: key !== requestedEngine,
          triedEngines,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS_HEADERS } }
      );
    } catch (err) {
      errors[key] = err?.message || 'Unknown error';
      continue; // automatic failsafe — try the next engine
    }
  }

  // Every attempted engine failed (or the time budget ran out).
  return new Response(
    JSON.stringify({
      error: true,
      message: 'All attempted engines failed. They may be rate-limited or the keys may be missing.',
      requestedEngine,
      triedEngines,
      details: errors,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache', ...CORS_HEADERS } }
  );
}
