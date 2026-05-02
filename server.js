require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY || 'test-api-key-123';

// ── Passord-håndtering ────────────────────────────────────────────────────────
let dashboardPassword = process.env.DASHBOARD_PASSWORD || 'admin123';
const JWT_SECRET = process.env.JWT_SECRET || uuidv4();
const SESSION_DURATION = 8 * 60 * 60 * 1000; // 8 timer

app.use(cors());
app.use(express.json());

// ── In-memory lagring ─────────────────────────────────────────────────────────
let inboundMessages = [];
let outboundQueue = [];
let sentMessages = [];
let failedMessages = [];
let fcmTokens = {};
let webhooks = [];
let autoReplyRules = [];
let sessions = {};

// ── Statistikk-hjelpere ───────────────────────────────────────────────────────
function getStats() {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;

    return {
        total: {
            inbound: inboundMessages.length,
            sent: sentMessages.length,
            failed: failedMessages.length,
            pending: outboundQueue.filter(m => m.status === 'pending').length
        },
        last24h: {
            inbound: inboundMessages.filter(m => m.receivedAt > oneDayAgo).length,
            sent: sentMessages.filter(m => m.sentAt > oneDayAgo).length
        },
        lastWeek: {
            inbound: inboundMessages.filter(m => m.receivedAt > oneWeekAgo).length,
            sent: sentMessages.filter(m => m.sentAt > oneWeekAgo).length
        },
        dailyBreakdown: getDailyBreakdown()
    };
}

function getDailyBreakdown() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const start = new Date();
        start.setDate(start.getDate() - i);
        start.setHours(0, 0, 0, 0);
        const end = new Date(start);
        end.setDate(end.getDate() + 1);

        days.push({
            date: start.toLocaleDateString('nb-NO', { weekday: 'short', day: 'numeric', month: 'short' }),
            inbound: inboundMessages.filter(m => m.receivedAt >= start.getTime() && m.receivedAt < end.getTime()).length,
            sent: sentMessages.filter(m => (m.sentAt || m.createdAt) >= start.getTime() && (m.sentAt || m.createdAt) < end.getTime()).length
        });
    }
    return days;
}

// ── Webhook-sending ───────────────────────────────────────────────────────────
async function triggerWebhooks(event, payload) {
    const activeWebhooks = webhooks.filter(w => w.enabled && w.events.includes(event));
    for (const webhook of activeWebhooks) {
        try {
            const body = JSON.stringify({ event, payload, timestamp: Date.now() });
            const signature = crypto.createHmac('sha256', webhook.secret || '').update(body).digest('hex');

            await fetch(webhook.url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Gateway-Signature': signature,
                    'X-Gateway-Event': event
                },
                body
            });
            console.log(`Webhook sendt til ${webhook.url} (${event})`);
        } catch (e) {
            console.error(`Webhook feilet for ${webhook.url}:`, e.message);
        }
    }
}

// ── Auto-svar sjekk ───────────────────────────────────────────────────────────
function checkAutoReply(from, body) {
    for (const rule of autoReplyRules.filter(r => r.enabled)) {
        let match = false;
        if (rule.isRegex) {
            try { match = new RegExp(rule.trigger, 'i').test(body); } catch {}
        } else {
            match = body.toLowerCase().includes(rule.trigger.toLowerCase());
        }

        if (match) {
            outboundQueue.push({
                id: uuidv4(),
                to: from,
                body: rule.response,
                priority: 10,
                status: 'pending',
                createdAt: Date.now(),
                source: 'auto-reply',
                ruleId: rule.id
            });
            console.log(`Auto-svar trigget for regel "${rule.name}" til ${from}`);
        }
    }
}

// ── Autentisering ─────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
        return res.status(401).json({ error: 'Ugyldig API-nøkkel' });
    }
    next();
}

function requireSession(req, res, next) {
    const token = req.headers['x-session-token'] || req.query.token;
    if (!token || !sessions[token] || sessions[token].expires < Date.now()) {
        if (token && sessions[token]) delete sessions[token];
        return res.status(401).json({ error: 'Ikke innlogget' });
    }
    sessions[token].expires = Date.now() + SESSION_DURATION;
    next();
}

// ── AUTENTISERING ─────────────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
    const { password } = req.body;
    if (password !== dashboardPassword) {
        return res.status(401).json({ error: 'Feil passord' });
    }
    const token = uuidv4();
    sessions[token] = { expires: Date.now() + SESSION_DURATION };
    res.json({ token, expiresIn: SESSION_DURATION });
});

app.post('/auth/logout', requireSession, (req, res) => {
    const token = req.headers['x-session-token'];
    delete sessions[token];
    res.json({ success: true });
});

app.post('/auth/change-password', requireSession, (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (currentPassword !== dashboardPassword) {
        return res.status(401).json({ error: 'Feil nåværende passord' });
    }
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ error: 'Nytt passord må være minst 8 tegn' });
    }
    dashboardPassword = newPassword;
    res.json({ success: true });
});

// ── HELSESJEKK ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'SMS Gateway Server kjører', version: '2.0.0' });
});

// ── INBOUND: Telefon → Server ─────────────────────────────────────────────────
app.post('/api/sms/inbound', requireApiKey, async (req, res) => {
    const { from, body, timestamp, receivedAt } = req.body;
    if (!from || !body) return res.status(400).json({ error: 'from og body er påkrevd' });

    const message = {
        id: uuidv4(),
        from,
        body,
        timestamp: timestamp || Date.now(),
        receivedAt: receivedAt || Date.now(),
        receivedByServerAt: Date.now()
    };

    inboundMessages.unshift(message);
    if (inboundMessages.length > 5000) inboundMessages = inboundMessages.slice(0, 5000);

    console.log(`📨 Innkommende SMS fra ${from}: "${body.substring(0, 50)}"`);

    // Trigger webhooks og auto-svar
    await triggerWebhooks('sms.received', message);
    checkAutoReply(from, body);

    res.status(200).json({ success: true, id: message.id });
});

// ── OUTBOUND: Server → Telefon ────────────────────────────────────────────────
app.get('/api/sms/pending', requireApiKey, (req, res) => {
    const pending = outboundQueue.filter(m => m.status === 'pending');
    res.json(pending);
});

app.post('/api/sms/:id/status', requireApiKey, async (req, res) => {
    const { id } = req.params;
    const { success, sentAt, errorMessage } = req.body;
    const msg = outboundQueue.find(m => m.id === id);
    if (!msg) return res.status(404).json({ error: 'Melding ikke funnet' });

    msg.status = success ? 'sent' : 'failed';
    msg.sentAt = sentAt;
    msg.errorMessage = errorMessage;

    if (success) {
        sentMessages.unshift(msg);
        await triggerWebhooks('sms.sent', msg);
    } else {
        failedMessages.unshift(msg);
        await triggerWebhooks('sms.failed', msg);
    }
    outboundQueue = outboundQueue.filter(m => m.id !== id);
    res.json({ success: true });
});

app.post('/api/sms/send', requireApiKey, (req, res) => {
    const { to, body, priority = 0 } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to og body er påkrevd' });

    const message = { id: uuidv4(), to, body, priority, status: 'pending', createdAt: Date.now() };
    outboundQueue.push(message);
    console.log(`📝 Ny melding i kø til ${to}`);
    res.status(201).json({ success: true, id: message.id });
});

// ── MELDINGER (dashboard) ─────────────────────────────────────────────────────
app.get('/api/sms/inbox', requireSession, (req, res) => {
    const { limit = 50, search = '' } = req.query;
    let msgs = inboundMessages;
    if (search) msgs = msgs.filter(m => m.from.includes(search) || m.body.toLowerCase().includes(search.toLowerCase()));
    res.json(msgs.slice(0, parseInt(limit)));
});

app.get('/api/sms/sent', requireSession, (req, res) => {
    const { limit = 50, search = '' } = req.query;
    let msgs = sentMessages;
    if (search) msgs = msgs.filter(m => m.to?.includes(search) || m.body?.toLowerCase().includes(search.toLowerCase()));
    res.json(msgs.slice(0, parseInt(limit)));
});

app.get('/api/sms/failed', requireSession, (req, res) => {
    res.json(failedMessages.slice(0, parseInt(req.query.limit) || 50));
});

app.post('/api/sms/send-dashboard', requireSession, (req, res) => {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to og body er påkrevd' });
    const message = { id: uuidv4(), to, body, priority: 0, status: 'pending', createdAt: Date.now(), source: 'dashboard' };
    outboundQueue.push(message);
    res.status(201).json({ success: true, id: message.id });
});

// ── EKSPORT CSV ───────────────────────────────────────────────────────────────
app.get('/api/export/inbox', requireSession, (req, res) => {
    const csv = ['Fra,Melding,Mottatt'].concat(
        inboundMessages.map(m => `"${m.from}","${m.body.replace(/"/g, '""')}","${new Date(m.receivedAt).toLocaleString('nb-NO')}"`)
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="innkommende.csv"');
    res.send('\ufeff' + csv);
});

app.get('/api/export/sent', requireSession, (req, res) => {
    const csv = ['Til,Melding,Sendt'].concat(
        sentMessages.map(m => `"${m.to}","${m.body?.replace(/"/g, '""')}","${new Date(m.sentAt || m.createdAt).toLocaleString('nb-NO')}"`)
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="sendte.csv"');
    res.send('\ufeff' + csv);
});

// ── STATISTIKK ────────────────────────────────────────────────────────────────
app.get('/api/stats', requireSession, (req, res) => {
    res.json(getStats());
});

// ── WEBHOOKS ──────────────────────────────────────────────────────────────────
app.get('/api/webhooks', requireSession, (req, res) => res.json(webhooks));

app.post('/api/webhooks', requireSession, (req, res) => {
    const { url, events, secret } = req.body;
    if (!url || !events?.length) return res.status(400).json({ error: 'url og events er påkrevd' });
    const webhook = { id: uuidv4(), url, events, secret: secret || uuidv4(), enabled: true, createdAt: Date.now() };
    webhooks.push(webhook);
    res.status(201).json(webhook);
});

app.put('/api/webhooks/:id', requireSession, (req, res) => {
    const webhook = webhooks.find(w => w.id === req.params.id);
    if (!webhook) return res.status(404).json({ error: 'Ikke funnet' });
    Object.assign(webhook, req.body);
    res.json(webhook);
});

app.delete('/api/webhooks/:id', requireSession, (req, res) => {
    webhooks = webhooks.filter(w => w.id !== req.params.id);
    res.json({ success: true });
});

// ── AUTO-SVAR REGLER ──────────────────────────────────────────────────────────
app.get('/api/rules', requireSession, (req, res) => res.json(autoReplyRules));

app.post('/api/rules', requireSession, (req, res) => {
    const { name, trigger, response, isRegex = false } = req.body;
    if (!name || !trigger || !response) return res.status(400).json({ error: 'name, trigger og response er påkrevd' });
    const rule = { id: uuidv4(), name, trigger, response, isRegex, enabled: true, createdAt: Date.now(), triggerCount: 0 };
    autoReplyRules.push(rule);
    res.status(201).json(rule);
});

app.put('/api/rules/:id', requireSession, (req, res) => {
    const rule = autoReplyRules.find(r => r.id === req.params.id);
    if (!rule) return res.status(404).json({ error: 'Ikke funnet' });
    Object.assign(rule, req.body);
    res.json(rule);
});

app.delete('/api/rules/:id', requireSession, (req, res) => {
    autoReplyRules = autoReplyRules.filter(r => r.id !== req.params.id);
    res.json({ success: true });
});

// ── FCM TOKEN ─────────────────────────────────────────────────────────────────
app.post('/api/device/fcm-token', requireApiKey, (req, res) => {
    const { token } = req.body;
    const deviceId = req.headers['x-device-id'] || 'default';
    fcmTokens[deviceId] = token;
    res.json({ success: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="no">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>SMS Gateway</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;color:#1a202c}
.login-overlay{position:fixed;inset:0;background:#0057A8;display:flex;align-items:center;justify-content:center;z-index:1000}
.login-box{background:white;border-radius:16px;padding:40px;width:360px;text-align:center}
.login-box h1{font-size:24px;margin-bottom:8px;color:#0057A8}
.login-box p{color:#666;margin-bottom:24px;font-size:14px}
.login-box input{width:100%;padding:12px;border:1px solid #ddd;border-radius:8px;font-size:15px;margin-bottom:12px}
.login-box button{width:100%;padding:12px;background:#0057A8;color:white;border:none;border-radius:8px;font-size:16px;cursor:pointer}
.login-box button:hover{background:#004494}
.login-error{color:#e53e3e;font-size:13px;margin-top:8px}
header{background:#0057A8;color:white;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
header h1{font-size:20px;font-weight:600}
.header-actions{display:flex;gap:12px;align-items:center}
.header-actions button{background:rgba(255,255,255,0.2);color:white;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px}
.header-actions button:hover{background:rgba(255,255,255,0.3)}
nav{background:white;border-bottom:1px solid #e2e8f0;display:flex;padding:0 24px}
nav button{padding:14px 20px;border:none;background:none;cursor:pointer;font-size:14px;color:#666;border-bottom:2px solid transparent}
nav button.active{color:#0057A8;border-bottom-color:#0057A8;font-weight:600}
.container{max-width:1200px;margin:24px auto;padding:0 16px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:24px}
.stat{background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.stat .num{font-size:32px;font-weight:700;color:#0057A8}
.stat .lbl{color:#718096;font-size:13px;margin-top:4px}
.card{background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.08);margin-bottom:20px}
.card h2{font-size:16px;font-weight:600;margin-bottom:16px;color:#2d3748}
.toolbar{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
input[type=text],input[type=password],input[type=url],textarea,select{padding:10px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;width:100%}
textarea{height:80px;resize:vertical}
.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:500}
.btn-primary{background:#0057A8;color:white}
.btn-primary:hover{background:#004494}
.btn-danger{background:#e53e3e;color:white}
.btn-sm{padding:6px 12px;font-size:12px}
.btn-outline{background:white;border:1px solid #e2e8f0;color:#4a5568}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 12px;background:#f7fafc;font-size:12px;color:#718096;font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
td{padding:12px;border-top:1px solid #f0f4f8;font-size:14px;vertical-align:top}
.badge{padding:3px 8px;border-radius:12px;font-size:11px;font-weight:600;display:inline-block}
.badge-green{background:#c6f6d5;color:#276749}
.badge-red{background:#fed7d7;color:#9b2c2c}
.badge-yellow{background:#fefcbf;color:#975a16}
.badge-blue{background:#bee3f8;color:#2c5282}
.chart-bar{height:200px;display:flex;align-items:flex-end;gap:4px;padding:8px 0}
.bar-group{flex:1;display:flex;flex-direction:column;align-items:center;gap:2px}
.bar-wrap{width:100%;display:flex;gap:2px;align-items:flex-end;height:160px}
.bar{flex:1;border-radius:4px 4px 0 0;min-height:2px;transition:height 0.3s}
.bar.inbound{background:#0057A8}
.bar.sent{background:#48BB78}
.bar-label{font-size:10px;color:#718096;text-align:center}
.legend{display:flex;gap:16px;margin-top:8px}
.legend-item{display:flex;align-items:center;gap:6px;font-size:12px;color:#718096}
.legend-dot{width:12px;height:12px;border-radius:50%}
.tab-content{display:none}
.tab-content.active{display:block}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.form-group{display:flex;flex-direction:column;gap:6px}
.form-group label{font-size:13px;font-weight:500;color:#4a5568}
.switch{position:relative;display:inline-block;width:44px;height:24px}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#ccc;border-radius:24px;transition:.3s}
.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.3s}
input:checked+.slider{background:#0057A8}
input:checked+.slider:before{transform:translateX(20px)}
.hidden{display:none}
#toast{position:fixed;bottom:24px;right:24px;background:#1a202c;color:white;padding:12px 20px;border-radius:8px;font-size:14px;opacity:0;transition:opacity 0.3s;z-index:9999}
#toast.show{opacity:1}
</style>
</head>
<body>

<div class="login-overlay" id="loginOverlay">
  <div class="login-box">
    <h1>📱 SMS Gateway</h1>
    <p>Logg inn for å administrere gateway</p>
    <input type="password" id="loginPassword" placeholder="Passord" onkeydown="if(event.key==='Enter')login()">
    <button onclick="login()">Logg inn</button>
    <div class="login-error hidden" id="loginError">Feil passord. Prøv igjen.</div>
  </div>
</div>

<div id="app" class="hidden">
  <header>
    <h1>📱 SMS Gateway Dashboard</h1>
    <div class="header-actions">
      <span id="headerStatus" style="font-size:13px;opacity:0.8"></span>
      <button onclick="showChangePassword()">🔑 Bytt passord</button>
      <button onclick="logout()">Logg ut</button>
    </div>
  </header>

  <nav>
    <button class="active" onclick="switchTab('overview')">📊 Oversikt</button>
    <button onclick="switchTab('inbox')">📨 Innkommende</button>
    <button onclick="switchTab('send')">📤 Send</button>
    <button onclick="switchTab('sent')">✅ Sendte</button>
    <button onclick="switchTab('webhooks')">🔗 Webhooks</button>
    <button onclick="switchTab('rules')">🤖 Auto-svar</button>
    <button onclick="switchTab('settings')">⚙️ Innstillinger</button>
  </nav>

  <div class="container">

    <!-- OVERSIKT -->
    <div id="tab-overview" class="tab-content active">
      <div class="stats-grid" id="statsGrid"></div>
      <div class="card">
        <h2>Meldinger siste 7 dager</h2>
        <div class="chart-bar" id="chart"></div>
        <div class="legend">
          <div class="legend-item"><div class="legend-dot" style="background:#0057A8"></div>Innkommende</div>
          <div class="legend-item"><div class="legend-dot" style="background:#48BB78"></div>Sendte</div>
        </div>
      </div>
    </div>

    <!-- INNKOMMENDE -->
    <div id="tab-inbox" class="tab-content">
      <div class="card">
        <h2>Innkommende meldinger</h2>
        <div class="toolbar">
          <input type="text" id="inboxSearch" placeholder="Søk etter nummer eller tekst..." style="max-width:300px" oninput="loadInbox()">
          <a href="/api/export/inbox?token=${getToken()}" class="btn btn-outline" download>⬇ Eksporter CSV</a>
          <button class="btn btn-outline" onclick="loadInbox()">↻ Oppdater</button>
        </div>
        <table><thead><tr><th>Fra</th><th>Melding</th><th>Tidspunkt</th></tr></thead>
        <tbody id="inboxTable"></tbody></table>
      </div>
    </div>

    <!-- SEND -->
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

    <!-- SENDTE -->
    <div id="tab-sent" class="tab-content">
      <div class="card">
        <h2>Sendte meldinger</h2>
        <div class="toolbar">
          <input type="text" id="sentSearch" placeholder="Søk..." style="max-width:300px" oninput="loadSent()">
          <a id="sentExportLink" href="#" class="btn btn-outline" download>⬇ Eksporter CSV</a>
          <button class="btn btn-outline" onclick="loadSent()">↻ Oppdater</button>
        </div>
        <table><thead><tr><th>Til</th><th>Melding</th><th>Status</th><th>Tidspunkt</th></tr></thead>
        <tbody id="sentTable"></tbody></table>
      </div>
    </div>

    <!-- WEBHOOKS -->
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
          <div style="display:flex;gap:16px;margin-top:6px">
            <label><input type="checkbox" value="sms.received" checked> Innkommende SMS</label>
            <label><input type="checkbox" value="sms.sent" checked> Sendt SMS</label>
            <label><input type="checkbox" value="sms.failed"> Mislykket sending</label>
          </div>
        </div>
        <button class="btn btn-primary" onclick="addWebhook()">Legg til webhook</button>
      </div>
      <div class="card">
        <h2>Aktive webhooks</h2>
        <table><thead><tr><th>URL</th><th>Hendelser</th><th>Status</th><th></th></tr></thead>
        <tbody id="webhooksTable"></tbody></table>
      </div>
    </div>

    <!-- AUTO-SVAR -->
    <div id="tab-rules" class="tab-content">
      <div class="card">
        <h2>Ny auto-svar regel</h2>
        <div class="form-row">
          <div class="form-group">
            <label>Navn på regel</label>
            <input type="text" id="ruleName" placeholder="F.eks. Velkomstmelding">
          </div>
          <div class="form-group">
            <label>Trigger (tekst som utløser svaret)</label>
            <input type="text" id="ruleTrigger" placeholder="F.eks. HJELP eller .*bestill.*">
          </div>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Svar</label>
          <textarea id="ruleResponse" placeholder="Automatisk svar som sendes tilbake..."></textarea>
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:14px">
          <input type="checkbox" id="ruleIsRegex"> Bruk regex (avansert)
        </label>
        <button class="btn btn-primary" onclick="addRule()">Legg til regel</button>
      </div>
      <div class="card">
        <h2>Aktive regler</h2>
        <table><thead><tr><th>Navn</th><th>Trigger</th><th>Svar</th><th>Aktiv</th><th></th></tr></thead>
        <tbody id="rulesTable"></tbody></table>
      </div>
    </div>

    <!-- INNSTILLINGER -->
    <div id="tab-settings" class="tab-content">
      <div class="card">
        <h2>Bytt dashboard-passord</h2>
        <div class="form-group" style="margin-bottom:12px">
          <label>Nåværende passord</label>
          <input type="password" id="currentPwd" placeholder="Nåværende passord">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Nytt passord</label>
          <input type="password" id="newPwd" placeholder="Minimum 8 tegn">
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Bekreft nytt passord</label>
          <input type="password" id="confirmPwd" placeholder="Gjenta nytt passord">
        </div>
        <button class="btn btn-primary" onclick="changePassword()">Lagre nytt passord</button>
        <div id="pwdStatus" style="margin-top:12px;font-size:14px"></div>
      </div>
      <div class="card">
        <h2>API-informasjon</h2>
        <p style="font-size:14px;color:#718096;margin-bottom:12px">Bruk denne informasjonen for å integrere med gateway-APIet.</p>
        <table>
          <tr><td style="font-weight:600;width:160px">Server URL</td><td id="serverUrl"></td></tr>
          <tr><td style="font-weight:600">API-endepunkter</td><td>
            <code>POST /api/sms/inbound</code><br>
            <code>GET /api/sms/pending</code><br>
            <code>POST /api/sms/send</code>
          </td></tr>
        </table>
      </div>
    </div>

  </div>
</div>

<div id="toast"></div>

<script>
let sessionToken = localStorage.getItem('sms_token') || '';
const BASE = window.location.origin;

function getToken() { return sessionToken; }

function api(path, opts={}) {
  return fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken, ...(opts.headers||{}) }
  }).then(r => r.json());
}

async function login() {
  const pwd = document.getElementById('loginPassword').value;
  const res = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: pwd })
  }).then(r => r.json());

  if (res.token) {
    sessionToken = res.token;
    localStorage.setItem('sms_token', sessionToken);
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
    init();
  } else {
    document.getElementById('loginError').classList.remove('hidden');
  }
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  localStorage.removeItem('sms_token');
  location.reload();
}

function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
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

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

async function loadStats() {
  const s = await api('/api/stats');
  document.getElementById('statsGrid').innerHTML = \`
    <div class="stat"><div class="num">\${s.total.inbound}</div><div class="lbl">Totalt innkommende</div></div>
    <div class="stat"><div class="num">\${s.total.sent}</div><div class="lbl">Totalt sendte</div></div>
    <div class="stat"><div class="num">\${s.last24h.inbound}</div><div class="lbl">Innkommende siste 24t</div></div>
    <div class="stat"><div class="num">\${s.last24h.sent}</div><div class="lbl">Sendte siste 24t</div></div>
    <div class="stat"><div class="num">\${s.total.pending}</div><div class="lbl">I kø</div></div>
    <div class="stat"><div class="num">\${s.total.failed}</div><div class="lbl">Mislykket</div></div>
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
  const tb = document.getElementById('inboxTable');
  tb.innerHTML = data.length ? data.map(m => \`
    <tr>
      <td><strong>\${m.from}</strong></td>
      <td style="max-width:400px;word-break:break-word">\${m.body}</td>
      <td style="white-space:nowrap;color:#718096">\${timeAgo(m.receivedAt)}</td>
    </tr>\`).join('') : '<tr><td colspan="3" style="color:#718096;text-align:center;padding:24px">Ingen meldinger ennå</td></tr>';
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
    </tr>\`).join('') : '<tr><td colspan="4" style="color:#718096;text-align:center;padding:24px">Ingen sendte meldinger</td></tr>';
  document.getElementById('sentExportLink').href = BASE + '/api/export/sent?token=' + sessionToken;
}

async function sendSms() {
  const to = document.getElementById('sendTo').value.trim();
  const body = document.getElementById('sendBody').value.trim();
  const status = document.getElementById('sendStatus');
  if (!to || !body) { status.textContent = '❌ Fyll inn mottaker og melding'; return; }
  const res = await api('/api/sms/send-dashboard', { method: 'POST', body: JSON.stringify({ to, body }) });
  if (res.success) {
    status.innerHTML = '<span style="color:#276749">✅ Melding lagt i kø! Gateway-telefonen sender den snart.</span>';
    document.getElementById('sendTo').value = '';
    document.getElementById('sendBody').value = '';
    loadStats();
    toast('Melding sendt!');
  }
}

async function loadWebhooks() {
  const data = await api('/api/webhooks');
  document.getElementById('webhooksTable').innerHTML = data.length ? data.map(w => \`
    <tr>
      <td style="word-break:break-all">\${w.url}</td>
      <td>\${w.events.join(', ')}</td>
      <td><span class="badge \${w.enabled ? 'badge-green' : 'badge-yellow'}">\${w.enabled ? 'Aktiv' : 'Pauset'}</span></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteWebhook('\${w.id}')">Slett</button></td>
    </tr>\`).join('') : '<tr><td colspan="4" style="color:#718096;text-align:center;padding:24px">Ingen webhooks ennå</td></tr>';
}

async function addWebhook() {
  const url = document.getElementById('webhookUrl').value.trim();
  const secret = document.getElementById('webhookSecret').value.trim();
  const events = [...document.querySelectorAll('#tab-webhooks input[type=checkbox]:checked')].map(c => c.value);
  if (!url) { toast('Skriv inn en URL'); return; }
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
      <td><code>\${r.trigger}</code>\${r.isRegex ? ' <span class="badge badge-blue">regex</span>' : ''}</td>
      <td style="max-width:200px;word-break:break-word">\${r.response}</td>
      <td><label class="switch"><input type="checkbox" \${r.enabled?'checked':''} onchange="toggleRule('\${r.id}',this.checked)"><span class="slider"></span></label></td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteRule('\${r.id}')">Slett</button></td>
    </tr>\`).join('') : '<tr><td colspan="5" style="color:#718096;text-align:center;padding:24px">Ingen regler ennå</td></tr>';
}

async function addRule() {
  const name = document.getElementById('ruleName').value.trim();
  const trigger = document.getElementById('ruleTrigger').value.trim();
  const response = document.getElementById('ruleResponse').value.trim();
  const isRegex = document.getElementById('ruleIsRegex').checked;
  if (!name || !trigger || !response) { toast('Fyll inn alle felter'); return; }
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
  const cur = document.getElementById('currentPwd').value;
  const nw = document.getElementById('newPwd').value;
  const cf = document.getElementById('confirmPwd').value;
  const st = document.getElementById('pwdStatus');
  if (nw !== cf) { st.innerHTML = '<span style="color:#e53e3e">Passordene er ikke like</span>'; return; }
  const res = await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
  if (res.success) {
    st.innerHTML = '<span style="color:#276749">✅ Passord endret!</span>';
    document.getElementById('currentPwd').value = '';
    document.getElementById('newPwd').value = '';
    document.getElementById('confirmPwd').value = '';
    toast('Passord endret!');
  } else {
    st.innerHTML = '<span style="color:#e53e3e">❌ ' + (res.error || 'Feil') + '</span>';
  }
}

function init() {
  document.getElementById('serverUrl').textContent = BASE;
  document.getElementById('sentExportLink').href = BASE + '/api/export/sent?token=' + sessionToken;
  loadStats();
  setInterval(loadStats, 30000);
}

// Sjekk eksisterende sesjon ved innlasting
async function checkSession() {
  if (!sessionToken) return;
  const res = await api('/api/stats').catch(() => null);
  if (res && !res.error) {
    document.getElementById('loginOverlay').style.display = 'none';
    document.getElementById('app').classList.remove('hidden');
    init();
  } else {
    localStorage.removeItem('sms_token');
    sessionToken = '';
  }
}

checkSession();
document.getElementById('loginPassword').addEventListener('keydown', e => { if(e.key==='Enter') login(); });
</script>
</body>
</html>`);
});

app.listen(PORT, () => {
    console.log('SMS Gateway Server v2.0 kjorer pa port ' + PORT);
    console.log('Dashboard: http://localhost:' + PORT + '/dashboard');
    console.log('Standard passord: ' + dashboardPassword);
});
