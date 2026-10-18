'use strict';
// Bishops Hull Hub - tiny dependency-free server (Node 18+).
// Serves ./public and creates Stripe Checkout sessions for Santa Grotto tickets.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader so no dependencies are needed.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
} catch (_) { /* no .env file */ }

const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TICKET_PRICE_PENCE = parseInt(process.env.TICKET_PRICE_PENCE || '500', 10);
const MAX_CHILDREN = 6;
const GENDERS = ['Girl', 'Boy', 'Prefer not to say'];
const PUBLIC = path.join(__dirname, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const json = (res, status, obj) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json' });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 20000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const clean = (s, max) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

function validate(b) {
  const parent = { name: clean(b?.parent?.name, 80), email: clean(b?.parent?.email, 120), phone: clean(b?.parent?.phone, 30) };
  if (!parent.name) return { error: 'Please tell us the grown-up’s name.' };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parent.email)) return { error: 'Please enter a valid email address.' };
  if (!parent.phone) return { error: 'Please add a contact phone number.' };
  if (!Array.isArray(b.children) || b.children.length < 1 || b.children.length > MAX_CHILDREN)
    return { error: `Please add between 1 and ${MAX_CHILDREN} children.` };
  const children = [];
  for (const c of b.children) {
    const name = clean(c.name, 60);
    const age = parseInt(c.age, 10);
    const gender = clean(c.gender, 30);
    if (!name) return { error: 'Every child needs a name.' };
    if (!(age >= 0 && age <= 17)) return { error: `Please enter a valid age for ${name}.` };
    if (!GENDERS.includes(gender)) return { error: `Please choose a gender for ${name}.` };
    children.push({ name, age, gender });
  }
  return { parent, children };
}

async function createCheckout(req, res) {
  if (!process.env.STRIPE_SECRET_KEY) return json(res, 500, { error: 'Payments are not set up yet.' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Bad request.' }); }
  const v = validate(body);
  if (v.error) return json(res, 400, { error: v.error });

  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('customer_email', v.parent.email);
  p.set('success_url', `${SITE_URL}/christmas2026/thank-you.html?session_id={CHECKOUT_SESSION_ID}`);
  p.set('cancel_url', `${SITE_URL}/christmas2026/`);
  p.set('line_items[0][quantity]', String(v.children.length));
  p.set('line_items[0][price_data][currency]', 'gbp');
  p.set('line_items[0][price_data][unit_amount]', String(TICKET_PRICE_PENCE));
  p.set('line_items[0][price_data][product_data][name]', 'Meet Santa - Bishops Hull Hub Santa Grotto');
  p.set('line_items[0][price_data][product_data][description]', 'Saturday 12th December 2026, 10am-12pm. Arrive before 11am to see Santa. One ticket per child.');
  p.set('metadata[event]', 'Santa Grotto 2026-12-12');
  p.set('metadata[parent_name]', v.parent.name);
  p.set('metadata[parent_phone]', v.parent.phone);
  v.children.forEach((c, i) => p.set(`metadata[child_${i + 1}]`, `${c.name} | age ${c.age} | ${c.gender}`));
  p.set('payment_intent_data[metadata][event]', 'Santa Grotto 2026-12-12');
  p.set('payment_intent_data[metadata][parent_name]', v.parent.name);
  v.children.forEach((c, i) => p.set(`payment_intent_data[metadata][child_${i + 1}]`, `${c.name} | age ${c.age} | ${c.gender}`));

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p,
    });
    const data = await r.json();
    if (!r.ok) { console.error('Stripe error', data.error); return json(res, 502, { error: 'Could not start payment. Please try again.' }); }
    json(res, 200, { url: data.url });
  } catch (e) {
    console.error(e);
    json(res, 502, { error: 'Could not reach the payment provider.' });
  }
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/christmas2026') return send(res, 301, '', { Location: '/christmas2026/' });
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.normalize(path.join(PUBLIC, urlPath));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'Not found');
    send(res, 200, buf, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  });
}

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/config') return json(res, 200, { pricePence: TICKET_PRICE_PENCE, maxChildren: MAX_CHILDREN });
  if (req.method === 'POST' && req.url === '/api/checkout') return createCheckout(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  send(res, 405, 'Method not allowed');
}).listen(PORT, () => console.log(`Bishops Hull Hub running on ${SITE_URL}`));
