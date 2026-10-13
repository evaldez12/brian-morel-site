/*
  POST /api/lead  (Cloudflare Pages Function, free plan)

  Receives a form submission from assets/lead.js and forwards it to GoHighLevel.
  Set these in Cloudflare Pages > Settings > Variables and Secrets (never in the site files):

    GHL_TOKEN          Private Integration token from the client's GoHighLevel sub-account
                       (Settings > Private Integrations, scopes: contacts.write, contacts.readonly)
    GHL_LOCATION_ID    The sub-account's Location ID
    GHL_WEBHOOK_URL    Optional alternative: a GoHighLevel workflow "Inbound Webhook" URL.
                       Used only when GHL_TOKEN is not set.
    META_PIXEL_ID      Optional: sends a server-side Lead event (Conversions API)
    META_CAPI_TOKEN    Optional: Conversions API access token
    META_API_VERSION   Optional: Graph API version, default v23.0
    TURNSTILE_SECRET   Optional: Cloudflare Turnstile secret, if the site key is set
    LEADS              Optional KV namespace binding: keeps a backup copy of every lead

  A lead is never silently dropped: if GoHighLevel can't be reached and there is no KV
  backup, the visitor gets an error and is asked to call or text instead.
*/

const GHL_API = 'https://services.leadconnectorhq.com';
const ALLOWED_FORMS = ['consultation', 'funding', 'giveaway', 'partner'];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function clean(v, max = 500) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '';
}

function slug(v) {
  return clean(v, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const out = await r.json().catch(() => ({}));
  return !!out.success;
}

function buildNote(lead) {
  const lines = [`Website form: ${lead.form}`, `Source: ${lead.source}`, `Page: ${lead.page}`, ''];
  for (const [k, v] of Object.entries(lead.fields)) {
    if (['first', 'last', 'email', 'phone', 'company_website'].includes(k) || !v) continue;
    lines.push(`${k.replace(/_/g, ' ')}: ${v}`);
  }
  lines.push('', `SMS consent: ${lead.sms_consent ? 'yes' : 'no'}`, `Received: ${lead.received_at}`);
  return lines.join('\n');
}

async function sendToGHL(env, lead) {
  if (env.GHL_TOKEN && env.GHL_LOCATION_ID) {
    const headers = {
      Authorization: `Bearer ${env.GHL_TOKEN}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const tags = ['website-lead', `form-${lead.form}`, `source-${slug(lead.source)}`];
    if (lead.sms_consent) tags.push('sms-opt-in');
    if (lead.ref) tags.push(`ref-${slug(lead.ref)}`);
    const contact = {
      locationId: env.GHL_LOCATION_ID,
      firstName: lead.fields.first || lead.fields.name || '',
      lastName: lead.fields.last || '',
      email: lead.email || undefined,
      phone: lead.phone || undefined,
      companyName: lead.fields.business_name || lead.fields.partner_business || undefined,
      source: `Website - ${lead.form}`,
      tags,
    };
    const r = await fetch(`${GHL_API}/contacts/upsert`, { method: 'POST', headers, body: JSON.stringify(contact) });
    if (!r.ok) throw new Error(`GoHighLevel upsert failed: ${r.status} ${await r.text()}`);
    const out = await r.json().catch(() => ({}));
    const id = out.contact && out.contact.id;
    if (id) {
      // The note is a nice-to-have; a failure here should not lose the lead.
      await fetch(`${GHL_API}/contacts/${id}/notes`, { method: 'POST', headers, body: JSON.stringify({ body: buildNote(lead) }) })
        .catch((e) => console.error('note failed', e));
    }
    return 'api';
  }
  if (env.GHL_WEBHOOK_URL) {
    const r = await fetch(env.GHL_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...lead, ...lead.fields, note: buildNote(lead) }),
    });
    if (!r.ok) throw new Error(`GoHighLevel webhook failed: ${r.status}`);
    return 'webhook';
  }
  return null;
}

async function sendToMeta(env, lead, request) {
  if (!env.META_PIXEL_ID || !env.META_CAPI_TOKEN) return;
  const user = {
    client_ip_address: request.headers.get('CF-Connecting-IP') || undefined,
    client_user_agent: request.headers.get('User-Agent') || undefined,
    fbp: lead.fbp || undefined,
    fbc: lead.fbc || undefined,
  };
  if (lead.email) user.em = [await sha256(lead.email.toLowerCase())];
  if (lead.phone) user.ph = [await sha256(lead.phone.replace(/\D/g, ''))];
  const version = env.META_API_VERSION || 'v23.0';
  const body = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: lead.event_id,
      action_source: 'website',
      event_source_url: lead.page,
      user_data: user,
      custom_data: { content_name: lead.form },
    }],
  };
  const r = await fetch(`https://graph.facebook.com/${version}/${env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(env.META_CAPI_TOKEN)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) console.error('Meta CAPI failed', r.status, await r.text());
}

export async function onRequestPost({ request, env, waitUntil }) {
  let input;
  try { input = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400); }

  const fields = {};
  for (const [k, v] of Object.entries(input.fields || {})) fields[clean(k, 40)] = clean(v);

  // Honeypot: real people never fill this hidden field.
  if (fields.company_website) return json({ ok: true });

  const form = ALLOWED_FORMS.includes(input.form) ? input.form : 'consultation';
  const email = clean(input.email, 120).toLowerCase();
  const phone = clean(input.phone, 20);
  if (!email && !phone) return json({ ok: false, error: 'missing_contact' }, 422);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env, clean(input.turnstile, 2048), ip))) return json({ ok: false, error: 'spam_check' }, 403);

  const attribution = input.attribution && typeof input.attribution === 'object' ? input.attribution : {};
  const lead = {
    form,
    fields,
    email,
    phone,
    sms_consent: input.sms_consent === true,
    page: clean(input.page, 300),
    source: clean(attribution.source, 120) || 'direct',
    ref: clean((attribution.last_touch || {}).ref, 60),
    attribution,
    event_id: clean(input.event_id, 80),
    fbp: clean(input.fbp, 120),
    fbc: clean(input.fbc, 200),
    received_at: new Date().toISOString(),
  };

  let backedUp = false;
  if (env.LEADS) {
    try { await env.LEADS.put(`lead:${lead.received_at}:${crypto.randomUUID()}`, JSON.stringify(lead)); backedUp = true; }
    catch (e) { console.error('KV backup failed', e); }
  }

  let delivered = null;
  try { delivered = await sendToGHL(env, lead); }
  catch (e) { console.error(e); }

  if (!delivered && !backedUp) {
    console.error('LEAD NOT DELIVERED', JSON.stringify(lead));
    return json({ ok: false, error: 'not_delivered' }, 502);
  }

  const meta = sendToMeta(env, lead, request).catch((e) => console.error('Meta error', e));
  if (waitUntil) waitUntil(meta); else await meta;

  return json({ ok: true, delivered: delivered || 'backup' });
}

export const onRequest = () => json({ ok: false, error: 'method_not_allowed' }, 405);
