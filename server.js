// SMS Gateway Server v2.0.02 - oppdatert 2026-05-02
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_SECRET = process.env.ADMIN_SECRET || uuidv4();

app.use(cors());
app.use(express.json());

// ── DATASTRUKTUR ──────────────────────────────────────────────────────────────
// tenants = { [tenantId]: { id, name, slug, apiKey, password, data: {...} } }
let tenants = {};
let adminSessions = {};
let tenantSessions = {};

// ── HJELPEFUNKSJONER ──────────────────────────────────────────────────────────
function generateApiKey() {
    return 'sk_' + crypto.randomBytes(24).toString('hex');
}

function slugify(name) {
    return name.toLowerCase()
        .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function getTenantByApiKey(apiKey) {
    return Object.values(tenants).find(t => t.apiKey === apiKey);
}

function getTenantBySlug(slug) {
    return Object.values(tenants).find(t => t.slug === slug);
}

function getStats(tenant) {
    const d = tenant.data;
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    return {
        total: {
            inbound: d.inboundMessages.length,
            sent: d.sentMessages.length,
            failed: d.failedMessages.length,
            pending: d.outboundQueue.filter(m => m.status === 'pending').length
        },
        last24h: {
            inbound: d.inboundMessages.filter(m => m.receivedAt > oneDayAgo).length,
            sent: d.sentMessages.filter(m => m.sentAt > oneDayAgo).length
        },
        dailyBreakdown: getDailyBreakdown(tenant)
    };
}

function getDailyBreakdown(tenant) {
    const d = tenant.data;
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const start = new Date();
        start.setDate(start.getDate() - i);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);
        days.push({
            date: start.toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' }),
            inbound: d.inboundMessages.filter(m => m.receivedAt >= start.getTime() && m.receivedAt < end.getTime()).length,
            sent: d.sentMessages.filter(m => (m.sentAt || m.createdAt) >= start.getTime() && (m.sentAt || m.createdAt) < end.getTime()).length
        });
    }
    return days;
}

async function triggerWebhooks(tenant, event, payload) {
    const active = tenant.data.webhooks.filter(w => w.enabled && w.events.includes(event));
    for (const webhook of active) {
        try {
            const body = JSON.stringify({ event, payload, timestamp: Date.now() });
            const sig = crypto.createHmac('sha256', webhook.secret || '').update(body).digest('hex');
            await fetch(webhook.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Gateway-Signature': sig, 'X-Gateway-Event': event },
                body
            });
        } catch (e) {
            console.error('Webhook feilet:', e.message);
        }
    }
}

function checkAutoReply(tenant, from, body) {
    for (const rule of tenant.data.autoReplyRules.filter(r => r.enabled)) {
        let match = false;
        if (rule.isRegex) {
            try { match = new RegExp(rule.trigger, 'i').test(body); } catch {}
        } else {
            match = body.toLowerCase().includes(rule.trigger.toLowerCase());
        }
        if (match) {
            tenant.data.outboundQueue.push({
                id: uuidv4(), to: from, body: rule.response,
                priority: 10, status: 'pending', createdAt: Date.now(), source: 'auto-reply'
            });
        }
    }
}

function createTenantData() {
    return {
        inboundMessages: [],
        outboundQueue: [],
        sentMessages: [],
        failedMessages: [],
        webhooks: [],
        autoReplyRules: [],
        fcmTokens: {}
    };
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !adminSessions[token] || adminSessions[token].expires < Date.now()) {
        return res.status(401).json({ error: 'Ikke innlogget som admin' });
    }
    adminSessions[token].expires = Date.now() + 8 * 60 * 60 * 1000;
    next();
}

function requireTenantSession(req, res, next) {
    const token = req.headers['x-session-token'];
    const session = tenantSessions[token];
    if (!token || !session || session.expires < Date.now()) {
        return res.status(401).json({ error: 'Ikke innlogget' });
    }
    session.expires = Date.now() + 8 * 60 * 60 * 1000;
    req.tenant = tenants[session.tenantId];
    if (!req.tenant) return res.status(401).json({ error: 'Kunde ikke funnet' });
    next();
}

function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    const tenant = getTenantByApiKey(key);
    if (!tenant) return res.status(401).json({ error: 'Ugyldig API-nøkkel' });
    req.tenant = tenant;
    next();
}

// ── HELSESJEKK ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SMS Gateway Server v3.0', version: '3.0.0' });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN API
// ══════════════════════════════════════════════════════════════════════════════

app.post('/admin/login', (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Feil passord' });
    }
    const token = uuidv4();
    adminSessions[token] = { expires: Date.now() + 8 * 60 * 60 * 1000 };
    res.json({ token });
});

app.get('/admin/tenants', requireAdmin, (req, res) => {
    res.json(Object.values(tenants).map(t => ({
        id: t.id, name: t.name, slug: t.slug,
        apiKey: t.apiKey, createdAt: t.createdAt,
        stats: {
            inbound: t.data.inboundMessages.length,
            sent: t.data.sentMessages.length,
            pending: t.data.outboundQueue.filter(m => m.status === 'pending').length
        }
    })));
});

app.post('/admin/tenants', requireAdmin, (req, res) => {
    const { name, password } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'name og password er påkrevd' });

    const slug = slugify(name);
    if (getTenantBySlug(slug)) return res.status(400).json({ error: 'En kunde med dette navnet finnes allerede' });

    const tenant = {
        id: uuidv4(),
        name,
        slug,
        password,
        apiKey: generateApiKey(),
        createdAt: Date.now(),
        data: createTenantData()
    };
    tenants[tenant.id] = tenant;
    console.log('Ny kunde opprettet:', name, '/', slug);
    res.status(201).json({ id: tenant.id, name, slug, apiKey: tenant.apiKey });
});

app.delete('/admin/tenants/:id', requireAdmin, (req, res) => {
    if (!tenants[req.params.id]) return res.status(404).json({ error: 'Ikke funnet' });
    const name = tenants[req.params.id].name;
    delete tenants[req.params.id];
    console.log('Kunde slettet:', name);
    res.json({ success: true });
});

app.put('/admin/tenants/:id', requireAdmin, (req, res) => {
    const tenant = tenants[req.params.id];
    if (!tenant) return res.status(404).json({ error: 'Ikke funnet' });
    if (req.body.password) tenant.password = req.body.password;
    if (req.body.name) { tenant.name = req.body.name; tenant.slug = slugify(req.body.name); }
    res.json({ success: true });
});

app.post('/admin/tenants/:id/regenerate-key', requireAdmin, (req, res) => {
    const tenant = tenants[req.params.id];
    if (!tenant) return res.status(404).json({ error: 'Ikke funnet' });
    tenant.apiKey = generateApiKey();
    res.json({ apiKey: tenant.apiKey });
});

// ══════════════════════════════════════════════════════════════════════════════
// TENANT AUTH
// ══════════════════════════════════════════════════════════════════════════════

app.post('/kunde/:slug/auth/login', (req, res) => {
    const tenant = getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Kunde ikke funnet' });
    if (req.body.password !== tenant.password) return res.status(401).json({ error: 'Feil passord' });

    const token = uuidv4();
    tenantSessions[token] = { tenantId: tenant.id, expires: Date.now() + 8 * 60 * 60 * 1000 };
    res.json({ token, tenantName: tenant.name });
});

app.post('/kunde/:slug/auth/change-password', requireTenantSession, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (currentPassword !== req.tenant.password) return res.status(401).json({ error: 'Feil nåværende passord' });
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Passord må være minst 8 tegn' });
    req.tenant.password = newPassword;
    res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// TENANT API (for dashboard)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/kunde/:slug/api/stats', requireTenantSession, (req, res) => res.json(getStats(req.tenant)));

app.get('/kunde/:slug/api/sms/inbox', requireTenantSession, (req, res) => {
    const { limit = 100, search = '' } = req.query;
    let msgs = req.tenant.data.inboundMessages;
    if (search) msgs = msgs.filter(m => m.from.includes(search) || m.body.toLowerCase().includes(search.toLowerCase()));
    res.json(msgs.slice(0, parseInt(limit)));
});

app.get('/kunde/:slug/api/sms/sent', requireTenantSession, (req, res) => {
    const { limit = 100, search = '' } = req.query;
    let msgs = req.tenant.data.sentMessages;
    if (search) msgs = msgs.filter(m => m.to?.includes(search) || m.body?.toLowerCase().includes(search.toLowerCase()));
    res.json(msgs.slice(0, parseInt(limit)));
});

app.post('/kunde/:slug/api/sms/send', requireTenantSession, (req, res) => {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to og body er påkrevd' });
    const msg = { id: uuidv4(), to, body, priority: 0, status: 'pending', createdAt: Date.now(), source: 'dashboard' };
    req.tenant.data.outboundQueue.push(msg);
    res.status(201).json({ success: true, id: msg.id });
});

app.get('/kunde/:slug/api/export/inbox', requireTenantSession, (req, res) => {
    const csv = ['Fra,Melding,Mottatt'].concat(
        req.tenant.data.inboundMessages.map(m =>
            `"${m.from}","${m.body.replace(/"/g, '""')}","${new Date(m.receivedAt).toLocaleString('nb-NO')}"`)
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="innkommende.csv"');
    res.send('\ufeff' + csv);
});

app.get('/kunde/:slug/api/export/sent', requireTenantSession, (req, res) => {
    const csv = ['Til,Melding,Sendt'].concat(
        req.tenant.data.sentMessages.map(m =>
            `"${m.to}","${(m.body||'').replace(/"/g, '""')}","${new Date(m.sentAt||m.createdAt).toLocaleString('nb-NO')}"`)
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sendte.csv"');
    res.send('\ufeff' + csv);
});

// Webhooks
app.get('/kunde/:slug/api/webhooks', requireTenantSession, (req, res) => res.json(req.tenant.data.webhooks));
app.post('/kunde/:slug/api/webhooks', requireTenantSession, (req, res) => {
    const { url, events, secret } = req.body;
    if (!url || !events?.length) return res.status(400).json({ error: 'url og events er påkrevd' });
    const webhook = { id: uuidv4(), url, events, secret: secret || uuidv4(), enabled: true, createdAt: Date.now() };
    req.tenant.data.webhooks.push(webhook);
    res.status(201).json(webhook);
});
app.put('/kunde/:slug/api/webhooks/:id', requireTenantSession, (req, res) => {
    const wh = req.tenant.data.webhooks.find(w => w.id === req.params.id);
    if (!wh) return res.status(404).json({ error: 'Ikke funnet' });
    Object.assign(wh, req.body);
    res.json(wh);
});
app.delete('/kunde/:slug/api/webhooks/:id', requireTenantSession, (req, res) => {
    req.tenant.data.webhooks = req.tenant.data.webhooks.filter(w => w.id !== req.params.id);
    res.json({ success: true });
});

// Auto-svar regler
app.get('/kunde/:slug/api/rules', requireTenantSession, (req, res) => res.json(req.tenant.data.autoReplyRules));
app.post('/kunde/:slug/api/rules', requireTenantSession, (req, res) => {
    const { name, trigger, response, isRegex = false } = req.body;
    if (!name || !trigger || !response) return res.status(400).json({ error: 'name, trigger og response er påkrevd' });
    const rule = { id: uuidv4(), name, trigger, response, isRegex, enabled: true, createdAt: Date.now() };
    req.tenant.data.autoReplyRules.push(rule);
    res.status(201).json(rule);
});
app.put('/kunde/:slug/api/rules/:id', requireTenantSession, (req, res) => {
    const rule = req.tenant.data.autoReplyRules.find(r => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: 'Ikke funnet' });
    Object.assign(rule, req.body);
    res.json(rule);
});
app.delete('/kunde/:slug/api/rules/:id', requireTenantSession, (req, res) => {
    req.tenant.data.autoReplyRules = req.tenant.data.autoReplyRules.filter(r => r.id !== req.params.id);
    res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ANDROID APP API (krever API-nøkkel)
// ══════════════════════════════════════════════════════════════════════════════

app.post('/api/sms/inbound', requireApiKey, async (req, res) => {
    const { from, body, timestamp, receivedAt } = req.body;
    if (!from || !body) return res.status(400).json({ error: 'from og body er påkrevd' });

    const message = { id: uuidv4(), from, body, timestamp: timestamp || Date.now(), receivedAt: receivedAt || Date.now() };
    req.tenant.data.inboundMessages.unshift(message);
    if (req.tenant.data.inboundMessages.length > 5000) {
        req.tenant.data.inboundMessages = req.tenant.data.inboundMessages.slice(0, 5000);
    }

    console.log(`[${req.tenant.name}] SMS fra ${from}: "${body.substring(0, 50)}"`);
    await triggerWebhooks(req.tenant, 'sms.received', message);
    checkAutoReply(req.tenant, from, body);

    res.json({ success: true, id: message.id });
});

app.get('/api/sms/pending', requireApiKey, (req, res) => {
    res.json(req.tenant.data.outboundQueue.filter(m => m.status === 'pending'));
});

app.post('/api/sms/:id/status', requireApiKey, async (req, res) => {
    const { success, sentAt, errorMessage } = req.body;
    const msg = req.tenant.data.outboundQueue.find(m => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'Melding ikke funnet' });

    msg.status = success ? 'sent' : 'failed';
    msg.sentAt = sentAt;
    msg.errorMessage = errorMessage;

    if (success) {
        req.tenant.data.sentMessages.unshift(msg);
        await triggerWebhooks(req.tenant, 'sms.sent', msg);
    } else {
        req.tenant.data.failedMessages.unshift(msg);
    }
    req.tenant.data.outboundQueue = req.tenant.data.outboundQueue.filter(m => m.id !== req.params.id);
    res.json({ success: true });
});

app.post('/api/device/fcm-token', requireApiKey, (req, res) => {
    const deviceId = req.headers['x-device-id'] || 'default';
    req.tenant.data.fcmTokens[deviceId] = req.body.token;
    res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

app.get('/admin', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS Gateway Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.login{display:flex;align-items:center;justify-content:center;min-height:100vh}
.login-box{background:#1e293b;border-radius:16px;padding:40px;width:360px;text-align:center}
.login-box h1{font-size:22px;margin-bottom:6px;color:#f8fafc}
.login-box p{color:#94a3b8;margin-bottom:24px;font-size:14px}
input{width:100%;padding:12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#f8fafc;font-size:15px;margin-bottom:12px}
.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500}
.btn-primary{background:#3b82f6;color:white;width:100%}
.btn-primary:hover{background:#2563eb}
.btn-danger{background:#ef4444;color:white}
.btn-danger:hover{background:#dc2626}
.btn-green{background:#22c55e;color:white}
.btn-sm{padding:6px 12px;font-size:12px}
header{background:#1e293b;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #334155}
header h1{font-size:18px;color:#f8fafc}
.container{max-width:1100px;margin:32px auto;padding:0 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}
.stat{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155}
.stat .num{font-size:28px;font-weight:700;color:#3b82f6}
.stat .lbl{color:#94a3b8;font-size:13px;margin-top:4px}
.card{background:#1e293b;border-radius:12px;padding:24px;border:1px solid #334155;margin-bottom:24px}
.card h2{font-size:16px;font-weight:600;margin-bottom:16px;color:#f8fafc}
.form-row{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end}
.form-group{display:flex;flex-direction:column;gap:6px}
.form-group label{font-size:13px;color:#94a3b8}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 12px;background:#0f172a;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase}
td{padding:12px;border-top:1px solid #334155;font-size:14px;color:#e2e8f0}
.badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600}
.badge-blue{background:#1d4ed8;color:#bfdbfe}
code{background:#0f172a;padding:2px 8px;border-radius:4px;font-size:12px;color:#7dd3fc;word-break:break-all}
.hidden{display:none}
#toast{position:fixed;bottom:24px;right:24px;background:#22c55e;color:white;padding:12px 20px;border-radius:8px;opacity:0;transition:opacity 0.3s;z-index:999}
#toast.show{opacity:1}
</style>
</head>
<body>

<div id="loginView" class="login">
  <div class="login-box">
    <h1>🔐 Admin Panel</h1>
    <p>SMS Gateway administrasjon</p>
    <input type="password" id="adminPwd" placeholder="Admin-passord" onkeydown="if(event.key==='Enter')adminLogin()">
    <button class="btn btn-primary" onclick="adminLogin()">Logg inn</button>
    <div id="loginErr" style="color:#f87171;margin-top:8px;font-size:13px"></div>
  </div>
</div>

<div id="adminView" class="hidden">
  <header>
    <h1>🔧 SMS Gateway Admin</h1>
    <button class="btn btn-danger btn-sm" onclick="adminLogout()">Logg ut</button>
  </header>
  <div class="container">

    <div class="stats" id="adminStats"></div>

    <div class="card">
      <h2>Opprett ny kunde</h2>
      <div class="form-row">
        <div class="form-group">
          <label>Firmanavn</label>
          <input type="text" id="newName" placeholder="F.eks. Firma AS">
        </div>
        <div class="form-group">
          <label>Passord</label>
          <input type="password" id="newPwd" placeholder="Minimum 8 tegn">
        </div>
        <button class="btn btn-green" onclick="createTenant()">Opprett</button>
      </div>
      <div id="createResult" style="margin-top:12px;font-size:13px"></div>
    </div>

    <div class="card">
      <h2>Kunder</h2>
      <table>
        <thead><tr><th>Firma</th><th>URL</th><th>API-nøkkel</th><th>Meldinger</th><th></th></tr></thead>
        <tbody id="tenantsTable"></tbody>
      </table>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
let adminToken = localStorage.getItem('admin_token') || '';
const BASE = window.location.origin;

function adminApi(path, opts={}) {
  return fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken, ...(opts.headers||{}) }
  }).then(r => r.json());
}

async function adminLogin() {
  const pwd = document.getElementById('adminPwd').value;
  const res = await fetch(BASE + '/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd })
  }).then(r => r.json());

  if (res.token) {
    adminToken = res.token;
    localStorage.setItem('admin_token', adminToken);
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('adminView').classList.remove('hidden');
    loadTenants();
  } else {
    document.getElementById('loginErr').textContent = 'Feil passord';
  }
}

function adminLogout() {
  localStorage.removeItem('admin_token');
  location.reload();
}

async function loadTenants() {
  const data = await adminApi('/admin/tenants');
  const total = data.reduce((a, t) => ({ inbound: a.inbound + t.stats.inbound, sent: a.sent + t.stats.sent }), { inbound: 0, sent: 0 });

  document.getElementById('adminStats').innerHTML = \`
    <div class="stat"><div class="num">\${data.length}</div><div class="lbl">Aktive kunder</div></div>
    <div class="stat"><div class="num">\${total.inbound}</div><div class="lbl">Totalt innkommende</div></div>
    <div class="stat"><div class="num">\${total.sent}</div><div class="lbl">Totalt sendte</div></div>
  \`;

  document.getElementById('tenantsTable').innerHTML = data.length ? data.map(t => \`
    <tr>
      <td><strong>\${t.name}</strong><br><span style="color:#64748b;font-size:12px">Opprettet \${new Date(t.createdAt).toLocaleDateString('nb-NO')}</span></td>
      <td><a href="/kunde/\${t.slug}/dashboard" target="_blank" style="color:#7dd3fc">/kunde/\${t.slug}</a></td>
      <td><code>\${t.apiKey}</code></td>
      <td>
        <span style="color:#4ade80">↓ \${t.stats.inbound}</span> &nbsp;
        <span style="color:#60a5fa">↑ \${t.stats.sent}</span>
        \${t.stats.pending > 0 ? '<span style="color:#fbbf24"> ⏳ ' + t.stats.pending + '</span>' : ''}
      </td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" style="background:#334155;color:#e2e8f0;margin-right:4px" onclick="regenKey('\${t.id}')">🔑 Ny nøkkel</button>
        <button class="btn btn-danger btn-sm" onclick="deleteTenant('\${t.id}', '\${t.name}')">Slett</button>
      </td>
    </tr>
  \`).join('') : '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:24px">Ingen kunder ennå</td></tr>';
}

async function createTenant() {
  const name = document.getElementById('newName').value.trim();
  const password = document.getElementById('newPwd').value;
  if (!name || !password) { toast('Fyll inn navn og passord'); return; }
  if (password.length < 8) { toast('Passord må være minst 8 tegn'); return; }

  const res = await adminApi('/admin/tenants', { method: 'POST', body: JSON.stringify({ name, password }) });
  if (res.id) {
    document.getElementById('createResult').innerHTML = \`
      <div style="background:#0f172a;padding:12px;border-radius:8px;border:1px solid #334155">
        <div style="color:#4ade80;margin-bottom:8px">✅ Kunde opprettet!</div>
        <div>Dashboard: <a href="/kunde/\${res.slug}/dashboard" target="_blank" style="color:#7dd3fc">/kunde/\${res.slug}/dashboard</a></div>
        <div style="margin-top:4px">API-nøkkel: <code>\${res.apiKey}</code></div>
        <div style="color:#94a3b8;font-size:12px;margin-top:8px">Gi kunden denne API-nøkkelen for Android-appen.</div>
      </div>
    \`;
    document.getElementById('newName').value = '';
    document.getElementById('newPwd').value = '';
    loadTenants();
  } else {
    toast(res.error || 'Feil ved opprettelse');
  }
}

async function deleteTenant(id, name) {
  if (!confirm('Slette ' + name + '? Dette kan ikke angres.')) return;
  await adminApi('/admin/tenants/' + id, { method: 'DELETE' });
  loadTenants();
  toast('Kunde slettet');
}

async function regenKey(id) {
  if (!confirm('Generer ny API-nøkkel? Den gamle slutter å fungere.')) return;
  const res = await adminApi('/admin/tenants/' + id + '/regenerate-key', { method: 'POST' });
  toast('Ny nøkkel: ' + res.apiKey);
  loadTenants();
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

// Sjekk eksisterende sesjon
async function checkAdminSession() {
  if (!adminToken) return;
  const res = await adminApi('/admin/tenants').catch(() => null);
  if (res && !res.error) {
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('adminView').classList.remove('hidden');
    loadTenants();
  } else {
    localStorage.removeItem('admin_token');
  }
}

checkAdminSession();
</script>
</body>
</html>`);
});

// ══════════════════════════════════════════════════════════════════════════════
// KUNDE DASHBOARD
// ══════════════════════════════════════════════════════════════════════════════

app.get('/kunde/:slug/dashboard', (req, res) => {
    const tenant = getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).send('<h1>Kunde ikke funnet</h1>');
    const slug = req.params.slug;

    res.send(`<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SMS Gateway - ${tenant.name}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f0f4f8;color:#1a202c}
.login-overlay{position:fixed;inset:0;background:#0057A8;display:flex;align-items:center;justify-content:center;z-index:1000}
.login-box{background:white;border-radius:16px;padding:40px;width:360px;text-align:center}
.login-box h1{font-size:22px;margin-bottom:6px;color:#0057A8}
.login-box p{color:#666;margin-bottom:24px;font-size:14px}
input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:12px;color:#1a202c}
.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500}
.btn-primary{background:#0057A8;color:white}
.btn-primary:hover{background:#004494}
.btn-danger{background:#e53e3e;color:white}
.btn-outline{background:white;border:1px solid #e2e8f0;color:#4a5568}
.btn-sm{padding:6px 12px;font-size:12px}
header{background:#0057A8;color:white;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:18px}
.header-right{display:flex;gap:12px;align-items:center;font-size:13px}
.header-right button{background:rgba(255,255,255,0.2);color:white;border:none;padding:8px 16px;border-radius:8px;cursor:pointer}
nav{background:white;border-bottom:1px solid #e2e8f0;display:flex;padding:0 24px;overflow-x:auto}
nav button{padding:14px 18px;border:none;background:none;cursor:pointer;font-size:14px;color:#666;border-bottom:2px solid transparent;white-space:nowrap}
nav button.active{color:#0057A8;border-bottom-color:#0057A8;font-weight:600}
.container{max-width:1200px;margin:24px auto;padding:0 16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-bottom:24px}
.stat{background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.stat .num{font-size:28px;font-weight:700;color:#0057A8}
.stat .lbl{color:#718096;font-size:13px;margin-top:4px}
.card{background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:20px}
.card h2{font-size:16px;font-weight:600;margin-bottom:16px}
.toolbar{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center}
textarea{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;height:80px;resize:vertical;font-size:14px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 12px;background:#f7fafc;font-size:12px;color:#718096;font-weight:600;text-transform:uppercase}
td{padding:12px;border-top:1px solid #f0f4f8;font-size:14px;vertical-align:top}
.badge{padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600}
.badge-green{background:#c6f6d5;color:#276749}
.badge-red{background:#fed7d7;color:#9b2c2c}
.chart-bar{height:180px;display:flex;align-items:flex-end;gap:4px}
.bar-group{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px}
.bar-wrap{width:100%;display:flex;gap:2px;align-items:flex-end;height:140px}
.bar{flex:1;border-radius:4px 4px 0 0;min-height:2px}
.bar.inbound{background:#0057A8}
.bar.sent{background:#48BB78}
.bar-label{font-size:10px;color:#718096;text-align:center}
.legend{display:flex;gap:16px;margin-top:8px}
.legend-item{display:flex;align-items:center;gap:6px;font-size:12px;color:#718096}
.legend-dot{width:10px;height:10px;border-radius:50%}
.tab-content{display:none}
.tab-content.active{display:block}
.switch{position:relative;display:inline-block;width:44px;height:24px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#ccc;border-radius:24px;transition:.3s}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.3s}
input:checked+.slider{background:#0057A8}
input:checked+.slider:before{transform:translateX(20px)}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.form-group{display:flex;flex-direction:column;gap:6px}
.form-group label{font-size:13px;font-weight:500;color:#4a5568}
.hidden{display:none}
#toast{position:fixed;bottom:24px;right:24px;background:#1a202c;color:white;padding:12px 20px;border-radius:8px;opacity:0;transition:opacity 0.3s;z-index:9999}
#toast.show{opacity:1}
</style>
</head>
<body>

<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h1>📱 SMS Gateway</h1>
    <p>${tenant.name}</p>
    <input type="password" id="loginPwd" placeholder="Passord" onkeydown="if(event.key==='Enter')login()">
    <button class="btn btn-primary" onclick="login()" style="width:100%">Logg inn</button>
    <div id="loginErr" style="color:#e53e3e;margin-top:8px;font-size:13px"></div>
  </div>
</div>

<div id="app" class="hidden">
  <header>
    <h1>📱 ${tenant.name}</h1>
    <div class="header-right">
      <span id="headerInfo"></span>
      <button onclick="logout()">Logg ut</button>
    </div>
  </header>
  <nav>
    <button class="active" onclick="switchTab('overview',this)">📊 Oversikt</button>
    <button onclick="switchTab('inbox',this)">📨 Innkommende</button>
    <button onclick="switchTab('send',this)">📤 Send</button>
    <button onclick="switchTab('sent',this)">✅ Sendte</button>
    <button onclick="switchTab('webhooks',this)">🔗 Webhooks</button>
    <button onclick="switchTab('rules',this)">🤖 Auto-svar</button>
    <button onclick="switchTab('settings',this)">⚙️ Innstillinger</button>
  </nav>

  <div class="container">

    <div id="tab-overview" class="tab-content active">
      <div class="stats" id="statsGrid"></div>
      <div class="card">
        <h2>Meldinger siste 7 dager</h2>
        <div class="chart-bar" id="chart"></div>
        <div class="legend">
          <div class="legend-item"><div class="legend-dot" style="background:#0057A8"></div>Innkommende</div>
          <div class="legend-item"><div class="legend-dot" style="background:#48BB78"></div>Sendte</div>
        </div>
      </div>
    </div>

    <div id="tab-inbox" class="tab-content">
      <div class="card">
        <h2>Innkommende meldinger</h2>
        <div class="toolbar">
          <input type="text" id="inboxSearch" placeholder="Søk..." style="max-width:280px" oninput="loadInbox()">
          <button class="btn btn-outline" id="inboxExport">⬇ CSV</button>
          <button class="btn btn-outline" onclick="loadInbox()">↻ Oppdater</button>
        </div>
        <table><thead><tr><th>Fra</th><th>Melding</th><th>Tidspunkt</th></tr></thead>
        <tbody id="inboxTable"></tbody></table>
      </div>
    </div>

    <div id="tab-send" class="tab-content">
      <div class="card">
        <h2>Send SMS via gateway</h2>
        <div class="form-group" style="margin-bottom:12px">
          <label>Mottaker</label>
          <input type="text" id="sendTo" placeholder="+4712345678">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Melding</label>
          <textarea id="sendBody" placeholder="Skriv melding..."></textarea>
        </div>
        <button class="btn btn-primary" onclick="sendSms()">Send SMS</button>
        <div id="sendStatus" style="margin-top:12px;font-size:14px"></div>
      </div>
    </div>

    <div id="tab-sent" class="tab-content">
      <div class="card">
        <h2>Sendte meldinger</h2>
        <div class="toolbar">
          <input type="text" id="sentSearch" placeholder="Søk..." style="max-width:280px" oninput="loadSent()">
          <button class="btn btn-outline" id="sentExport">⬇ CSV</button>
          <button class="btn btn-outline" onclick="loadSent()">↻ Oppdater</button>
        </div>
        <table><thead><tr><th>Til</th><th>Melding</th><th>Status</th><th>Tidspunkt</th></tr></thead>
        <tbody id="sentTable"></tbody></table>
      </div>
    </div>

    <div id="tab-webhooks" class="tab-content">
      <div class="card">
        <h2>Legg til webhook</h2>
        <div class="form-row">
          <div class="form-group">
            <label>URL</label>
            <input type="url" id="webhookUrl" placeholder="https://ditt-system.no/webhook">
          </div>
          <div class="form-group">
            <label>Hemmelig nøkkel (valgfri)</label>
            <input type="text" id="webhookSecret" placeholder="Genereres automatisk">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Hendelser</label>
          <div style="display:flex;gap:16px;margin-top:6px;font-size:14px">
            <label><input type="checkbox" value="sms.received" checked> Innkommende</label>
            <label><input type="checkbox" value="sms.sent" checked> Sendt</label>
            <label><input type="checkbox" value="sms.failed"> Mislykket</label>
          </div>
        </div>
        <button class="btn btn-primary" onclick="addWebhook()">Legg til</button>
      </div>
      <div class="card">
        <h2>Aktive webhooks</h2>
        <table><thead><tr><th>URL</th><th>Hendelser</th><th>Status</th><th></th></tr></thead>
        <tbody id="webhooksTable"></tbody></table>
      </div>
    </div>

    <div id="tab-rules" class="tab-content">
      <div class="card">
        <h2>Ny auto-svar regel</h2>
        <div class="form-row">
          <div class="form-group">
            <label>Navn</label>
            <input type="text" id="ruleName" placeholder="F.eks. Velkomstmelding">
          </div>
          <div class="form-group">
            <label>Trigger</label>
            <input type="text" id="ruleTrigger" placeholder="F.eks. HJELP">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Svar</label>
          <textarea id="ruleResponse" placeholder="Automatisk svar..."></textarea>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:14px">
          <input type="checkbox" id="ruleIsRegex"> Bruk regex
        </label>
        <button class="btn btn-primary" onclick="addRule()">Legg til regel</button>
      </div>
      <div class="card">
        <h2>Regler</h2>
        <table><thead><tr><th>Navn</th><th>Trigger</th><th>Svar</th><th>Aktiv</th><th></th></tr></thead>
        <tbody id="rulesTable"></tbody></table>
      </div>
    </div>

    <div id="tab-settings" class="tab-content">
      <div class="card">
        <h2>Bytt passord</h2>
        <div class="form-group" style="margin-bottom:12px">
          <label>Nåværende passord</label>
          <input type="password" id="curPwd">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Nytt passord</label>
          <input type="password" id="newPwdField" placeholder="Minimum 8 tegn">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Bekreft nytt passord</label>
          <input type="password" id="cfmPwd">
        </div>
        <button class="btn btn-primary" onclick="changePassword()">Lagre</button>
        <div id="pwdStatus" style="margin-top:12px;font-size:14px"></div>
      </div>
    </div>

  </div>
</div>
<div id="toast"></div>

<script>
const SLUG = '${slug}';
const BASE = window.location.origin;
let token = localStorage.getItem('sms_token_' + SLUG) || '';

function api(path, opts={}) {
  return fetch(BASE + '/kunde/' + SLUG + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': token, ...(opts.headers||{}) }
  }).then(r => r.json());
}

async function login() {
  const pwd = document.getElementById('loginPwd').value;
  const res = await fetch(BASE + '/kunde/' + SLUG + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd })
  }).then(r => r.json());

  if (res.token) {
    token = res.token;
    localStorage.setItem('sms_token_' + SLUG, token);
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
    init();
  } else {
    document.getElementById('loginErr').textContent = 'Feil passord';
  }
}

function logout() {
  localStorage.removeItem('sms_token_' + SLUG);
  location.reload();
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'inbox') loadInbox();
  if (name === 'sent') loadSent();
  if (name === 'webhooks') loadWebhooks();
  if (name === 'rules') loadRules();
  if (name === 'overview') loadStats();
}

function timeAgo(ts) {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return d + 's siden';
  if (d < 3600) return Math.floor(d/60) + 'm siden';
  if (d < 86400) return Math.floor(d/3600) + 't siden';
  return new Date(ts).toLocaleString('nb-NO');
}

function toast(msg, ok=true) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = ok ? '#1a202c' : '#e53e3e';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

async function loadStats() {
  const s = await api('/api/stats');
  document.getElementById('statsGrid').innerHTML = \`
    <div class="stat"><div class="num">\${s.total.inbound}</div><div class="lbl">Totalt innkommende</div></div>
    <div class="stat"><div class="num">\${s.total.sent}</div><div class="lbl">Totalt sendte</div></div>
    <div class="stat"><div class="num">\${s.last24h.inbound}</div><div class="lbl">Siste 24t innkommende</div></div>
    <div class="stat"><div class="num">\${s.last24h.sent}</div><div class="lbl">Siste 24t sendte</div></div>
    <div class="stat"><div class="num">\${s.total.pending}</div><div class="lbl">I kø</div></div>
  \`;
  const max = Math.max(...s.dailyBreakdown.map(d => Math.max(d.inbound, d.sent)), 1);
  document.getElementById('chart').innerHTML = s.dailyBreakdown.map(d => \`
    <div class="bar-group">
      <div class="bar-wrap">
        <div class="bar inbound" style="height:\${Math.max(d.inbound/max*100,2)}%"></div>
        <div class="bar sent" style="height:\${Math.max(d.sent/max*100,2)}%"></div>
      </div>
      <div class="bar-label">\${d.date}</div>
    </div>
  \`).join('');
}

async function loadInbox() {
  const search = document.getElementById('inboxSearch')?.value || '';
  const data = await api('/api/sms/inbox?limit=100&search=' + encodeURIComponent(search));
  document.getElementById('inboxTable').innerHTML = data.length ? data.map(m => \`
    <tr>
      <td><strong>\${m.from}</strong></td>
      <td style="max-width:400px;word-break:break-word">\${m.body}</td>
      <td style="white-space:nowrap;color:#718096">\${timeAgo(m.receivedAt)}</td>
    </tr>\`).join('') : '<tr><td colspan="3" style="text-align:center;color:#718096;padding:24px">Ingen meldinger</td></tr>';
  document.getElementById('inboxExport').onclick = () => {
    window.location.href = BASE + '/kunde/' + SLUG + '/api/export/inbox?token=' + token;
  };
}

async function loadSent() {
  const search = document.getElementById('sentSearch')?.value || '';
  const data = await api('/api/sms/sent?limit=100&search=' + encodeURIComponent(search));
  document.getElementById('sentTable').innerHTML = data.length ? data.map(m => \`
    <tr>
      <td><strong>\${m.to}</strong></td>
      <td style="max-width:400px;word-break:break-word">\${m.body||''}</td>
      <td><span class="badge badge-green">Sendt</span></td>
      <td style="white-space:nowrap;color:#718096">\${timeAgo(m.sentAt||m.createdAt)}</td>
    </tr>\`).join('') : '<tr><td colspan="4" style="text-align:center;color:#718096;padding:24px">Ingen sendte</td></tr>';
  document.getElementById('sentExport').onclick = () => {
    window.location.href = BASE + '/kunde/' + SLUG + '/api/export/sent?token=' + token;
  };
}

async function sendSms() {
  const to = document.getElementById('sendTo').value.trim();
  const body = document.getElementById('sendBody').value.trim();
  const st = document.getElementById('sendStatus');
  if (!to || !body) { st.textContent = 'Fyll inn mottaker og melding'; return; }
  const res = await api('/api/sms/send', { method: 'POST', body: JSON.stringify({ to, body }) });
  if (res.success) {
    st.innerHTML = '<span style="color:#276749">✅ Lagt i kø!</span>';
    document.getElementById('sendTo').value = '';
    document.getElementById('sendBody').value = '';
    toast('Melding sendt!');
  }
}

async function loadWebhooks() {
  const data = await api('/api/webhooks');
  document.getElementById('webhooksTable').innerHTML = data.length ? data.map(w => \`
    <tr>
      <td style="word-break:break-all">\${w.url}</td>
      <td>\${w.events.join(', ')}</td>
      <td><span class="badge \${w.enabled?'badge-green':''}">​\${w.enabled?'Aktiv':'Pauset'}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteWebhook('\${w.id}')">Slett</button></td>
    </tr>\`).join('') : '<tr><td colspan="4" style="text-align:center;color:#718096;padding:24px">Ingen webhooks</td></tr>';
}

async function addWebhook() {
  const url = document.getElementById('webhookUrl').value.trim();
  const secret = document.getElementById('webhookSecret').value.trim();
  const events = [...document.querySelectorAll('#tab-webhooks input[type=checkbox]:checked')].map(c => c.value);
  if (!url) { toast('Skriv inn URL', false); return; }
  await api('/api/webhooks', { method: 'POST', body: JSON.stringify({ url, secret, events }) });
  document.getElementById('webhookUrl').value = '';
  loadWebhooks();
  toast('Webhook lagt til!');
}

async function deleteWebhook(id) {
  await api('/api/webhooks/' + id, { method: 'DELETE' });
  loadWebhooks();
  toast('Webhook slettet');
}

async function loadRules() {
  const data = await api('/api/rules');
  document.getElementById('rulesTable').innerHTML = data.length ? data.map(r => \`
    <tr>
      <td><strong>\${r.name}</strong></td>
      <td><code>\${r.trigger}</code></td>
      <td style="max-width:200px;word-break:break-word">\${r.response}</td>
      <td><label class="switch"><input type="checkbox" \${r.enabled?'checked':''} onchange="toggleRule('\${r.id}',this.checked)"><span class="slider"></span></label></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteRule('\${r.id}')">Slett</button></td>
    </tr>\`).join('') : '<tr><td colspan="5" style="text-align:center;color:#718096;padding:24px">Ingen regler</td></tr>';
}

async function addRule() {
  const name = document.getElementById('ruleName').value.trim();
  const trigger = document.getElementById('ruleTrigger').value.trim();
  const response = document.getElementById('ruleResponse').value.trim();
  const isRegex = document.getElementById('ruleIsRegex').checked;
  if (!name || !trigger || !response) { toast('Fyll inn alle felter', false); return; }
  await api('/api/rules', { method: 'POST', body: JSON.stringify({ name, trigger, response, isRegex }) });
  document.getElementById('ruleName').value = '';
  document.getElementById('ruleTrigger').value = '';
  document.getElementById('ruleResponse').value = '';
  loadRules();
  toast('Regel lagt til!');
}

async function toggleRule(id, enabled) {
  await api('/api/rules/' + id, { method: 'PUT', body: JSON.stringify({ enabled }) });
}

async function deleteRule(id) {
  await api('/api/rules/' + id, { method: 'DELETE' });
  loadRules();
  toast('Regel slettet');
}

async function changePassword() {
  const cur = document.getElementById('curPwd').value;
  const nw = document.getElementById('newPwdField').value;
  const cf = document.getElementById('cfmPwd').value;
  const st = document.getElementById('pwdStatus');
  if (nw !== cf) { st.innerHTML = '<span style="color:#e53e3e">Passordene er ikke like</span>'; return; }
  const res = await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
  if (res.success) {
    st.innerHTML = '<span style="color:#276749">✅ Passord endret!</span>';
    toast('Passord endret!');
  } else {
    st.innerHTML = '<span style="color:#e53e3e">❌ ' + (res.error||'Feil') + '</span>';
  }
}

function init() {
  loadStats();
  setInterval(loadStats, 30000);
}

async function checkSession() {
  if (!token) return;
  const res = await api('/api/stats').catch(() => null);
  if (res && !res.error) {
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
    init();
  } else {
    localStorage.removeItem('sms_token_' + SLUG);
    token = '';
  }
}

checkSession();
document.getElementById('loginPwd').addEventListener('keydown', e => { if(e.key==='Enter') login(); });
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log('SMS Gateway Server v3.0 - Multi-tenant');
    console.log('Admin panel: http://localhost:' + PORT + '/admin');
    console.log('Admin passord: ' + ADMIN_PASSWORD);
});
