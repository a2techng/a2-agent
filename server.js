import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
app.use(cors({ origin(origin, cb) {
  if (!origin || origins.length === 0 || origins.includes(origin)) return cb(null, true);
  return cb(new Error('Origin is not allowed by ALLOWED_ORIGINS'));
}}));
app.use(express.json({ limit: '1mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

function requireText(value, label, max = 12000) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${label} is required.`), { status: 400 });
  if (value.length > max) throw Object.assign(new Error(`${label} is too long (max ${max} characters).`), { status: 413 });
  return value.trim();
}
async function gemini(contents, { systemInstruction, tools, generationConfig } = {}) {
  if (!process.env.GEMINI_API_KEY) throw Object.assign(new Error('AI is not configured yet. Add GEMINI_API_KEY to the backend environment variables.'), { status: 503 });
  const body = { contents };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
  if (tools) body.tools = tools;
  if (generationConfig) body.generationConfig = generationConfig;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || `AI provider returned HTTP ${response.status}`;
    throw Object.assign(new Error(message), { status: response.status === 429 ? 429 : 502 });
  }
  return data;
}
function candidateText(data) { return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n').trim() || ''; }

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'A² Agent API', version: '0.4.0', aiConfigured: Boolean(process.env.GEMINI_API_KEY), model: MODEL, timestamp: new Date().toISOString() }));

app.post('/api/chat', async (req, res, next) => {
  try {
    const message = requireText(req.body?.message, 'message', 12000);
    const system = typeof req.body?.systemInstruction === 'string' ? req.body.systemInstruction.slice(0, 3000) : 'You are A² Agent, a helpful AI assistant built by A² Tech. Be accurate, explain uncertainty, give safe step-by-step help, and never claim to control the phone unless a verified native bridge reports success. For app-building requests, give practical implementation advice.';
    const data = await gemini([{ role: 'user', parts: [{ text: message }] }], { systemInstruction: system });
    const reply = candidateText(data);
    if (!reply) throw Object.assign(new Error('The AI provider returned no text.'), { status: 502 });
    res.json({ ok: true, reply, model: MODEL });
  } catch (err) { next(err); }
});

app.get('/api/search', async (req, res, next) => {
  try {
    const q = requireText(String(req.query.q || ''), 'q', 1000);
    const data = await gemini([{ role: 'user', parts: [{ text: `Research this topic using web search where available: ${q}. Give a concise factual summary, distinguish uncertainty, and include source URLs/titles when available.` }] }], { tools: [{ google_search: {} }] });
    const meta = data?.candidates?.[0]?.groundingMetadata;
    const sources = (meta?.groundingChunks || []).map(c => c.web).filter(w => w?.uri).map(w => ({ title: w.title || w.uri, url: w.uri }));
    res.json({ ok: true, query: q, summary: candidateText(data), sources: [...new Map(sources.map(s => [s.url, s])).values()] });
  } catch (err) { next(err); }
});

app.post('/api/project/generate', async (req, res, next) => {
  try {
    const prompt = requireText(req.body?.prompt, 'prompt', 5000);
    const instruction = `You are a senior front-end developer. Generate a complete, working, mobile-first web app for the user's request. Return only a JSON object with string properties index.html, style.css, app.js. Keep all app code inside those files, use semantic accessible HTML, responsive CSS, and safe JavaScript. Do not include secrets or call external services with embedded API keys. The HTML must link style.css and app.js. Do not wrap JSON in markdown.`;
    const data = await gemini([{ role: 'user', parts: [{ text: `Build this project: ${prompt}` }] }], { systemInstruction: instruction, generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { 'index.html': { type: 'STRING' }, 'style.css': { type: 'STRING' }, 'app.js': { type: 'STRING' } }, required: ['index.html', 'style.css', 'app.js'] } } });
    const text = candidateText(data);
    let files;
    try { files = JSON.parse(text); } catch { throw Object.assign(new Error('AI response was not valid project JSON. Try a shorter app description.'), { status: 502 }); }
    for (const name of ['index.html', 'style.css', 'app.js']) if (typeof files[name] !== 'string') throw Object.assign(new Error(`AI response did not include ${name}.`), { status: 502 });
    res.json({ ok: true, files, model: MODEL });
  } catch (err) { next(err); }
});

app.post('/api/deploy/netlify', async (req, res, next) => {
  try {
    const files = req.body?.files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw Object.assign(new Error('Provide project files as an object.'), { status: 400 });
    if (!process.env.NETLIFY_AUTH_TOKEN || !process.env.NETLIFY_SITE_ID) throw Object.assign(new Error('Netlify deployment is not configured. Add NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID on the backend, or export the ZIP and deploy manually.'), { status: 503 });
    // Netlify's API expects a deploy archive or file manifest. Avoid pretending a deploy happened without a valid archive.
    res.status(501).json({ ok: false, error: 'Automated Netlify deployment still needs the ZIP upload workflow configured. Export the project ZIP for now.' });
  } catch (err) { next(err); }
});

app.get('*', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use((err, _req, res, _next) => {
  const status = Number(err.status) || 500;
  if (status >= 500) console.error('[A² Agent API]', err.message);
  res.status(status).json({ ok: false, error: status === 500 ? 'Unexpected backend error. Check the server logs.' : err.message });
});
app.listen(PORT, () => console.log(`A² Agent backend listening on port ${PORT}; AI configured: ${Boolean(process.env.GEMINI_API_KEY)}`));
