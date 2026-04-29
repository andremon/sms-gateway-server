require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'test-api-key-123';

app.use(cors());
app.use(express.json());

// ── In-memory lagring (erstattes med database senere) ─────────────────────────
let inboundMessages = [];   // Mottatte SMS fra telefon → server
let outboundQueue = [];     // Meldinger som venter på å bli sendt
let sentMessages = [];      // Sendte meldinger med status
let fcmTokens = {};         // { deviceId: fcmToken }

// ── Autentisering ─────────────────────────────────────────────────────────────
function requireApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== API_KEY) {
        return res.status(401).json({ error: 'Ugyldig API-nøkkel' });
    }
    next();
}

// ── HELSESJEKK ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: 'SMS Gateway Server kjører',
        endpoints: [
            'POST /api/sms/inbound',
            'GET  /api/sms/pending',
            'POST /api/sms/:id/status',
            'POST /api/sms/send',
            'GET  /api/sms/inbox',
            'GET  /api/sms/sent',
            'POST /api/device/fcm-token',
            'GET  /dashboard'
        ]
    });
});

// ── INBOUND: Telefon → Server ─────────────────────────────────────────────────
// Android-appen kaller dette når den mottar en SMS
app.post('/api/sms/inbound', requireApiKey, (req, res) => {
    const { from, body, timestamp, receivedAt } = req.body;

    if (!from || !body) {
        return res.status(400).json({ error: 'from og body er påkrevd' });
    }

    const message = {
        id: uuidv4(),
        from,
        body,
        timestamp: timestamp || Date.now(),
        receivedAt: receivedAt || Date.now(),
        receivedByServerAt: Date.now()
    };

    inboundMessages.unshift(message);

    // Behold maks 1000 meldinger i minnet
    if (inboundMessages.length > 1000) {
        inboundMessages = inboundMessages.slice(0, 1000);
    }

    console.log(`📨 Innkommende SMS fra ${from}: "${body.substring(0, 50)}..."`);

    // TODO: Her kan du legge til webhook-videresending
    // sendWebhook(message);

    res.status(200).json({ success: true, id: message.id });
});

// ── OUTBOUND: Server → Telefon (polling) ─────────────────────────────────────
// Android-appen henter ventende meldinger herfra
app.get('/api/sms/pending', requireApiKey, (req, res) => {
    const pending = outboundQueue.filter(m => m.status === 'pending');
    console.log(`📤 Telefon henter ${pending.length} ventende meldinger`);
    res.json(pending);
});

// ── STATUS: Telefon rapporterer sendestatus ───────────────────────────────────
app.post('/api/sms/:id/status', requireApiKey, (req, res) => {
    const { id } = req.params;
    const { success, sentAt, errorMessage } = req.body;

    const msg = outboundQueue.find(m => m.id === id);
    if (!msg) {
        return res.status(404).json({ error: 'Melding ikke funnet' });
    }

    msg.status = success ? 'sent' : 'failed';
    msg.sentAt = sentAt;
    msg.errorMessage = errorMessage;

    sentMessages.unshift(msg);
    outboundQueue = outboundQueue.filter(m => m.id !== id);

    console.log(`${success ? '✅' : '❌'} Melding ${id} til ${msg.to}: ${success ? 'sendt' : 'feilet'}`);
    res.json({ success: true });
});

// ── SEND: Legg til melding i outbound-køen ────────────────────────────────────
// Kall dette fra ditt system når du vil sende en SMS via gateway-telefonen
app.post('/api/sms/send', requireApiKey, (req, res) => {
    const { to, body, priority = 0 } = req.body;

    if (!to || !body) {
        return res.status(400).json({ error: 'to og body er påkrevd' });
    }

    const message = {
        id: uuidv4(),
        to,
        body,
        priority,
        status: 'pending',
        createdAt: Date.now()
    };

    outboundQueue.push(message);
    console.log(`📝 Ny melding i kø til ${to}: "${body.substring(0, 50)}"`);

    res.status(201).json({ success: true, id: message.id });
});

// ── INNBOKS: Hent alle mottatte meldinger ─────────────────────────────────────
app.get('/api/sms/inbox', requireApiKey, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(inboundMessages.slice(0, limit));
});

// ── SENDT: Hent alle sendte meldinger ────────────────────────────────────────
app.get('/api/sms/sent', requireApiKey, (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(sentMessages.slice(0, limit));
});

// ── FCM TOKEN ─────────────────────────────────────────────────────────────────
app.post('/api/device/fcm-token', requireApiKey, (req, res) => {
    const { token } = req.body;
    const deviceId = req.headers['x-device-id'] || 'default';
    fcmTokens[deviceId] = token;
    console.log(`📱 FCM-token oppdatert for enhet ${deviceId}`);
    res.json({ success: true });
});

// ── DASHBOARD ─────────────────────────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="no">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SMS Gateway Dashboard</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: -apple-system, sans-serif; background: #f0f2f5; color: #1a1a2e; }
        header { background: #0057A8; color: white; padding: 20px 32px; }
        header h1 { font-size: 22px; }
        header p { opacity: 0.8; font-size: 14px; margin-top: 4px; }
        .container { max-width: 1100px; margin: 32px auto; padding: 0 16px; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 32px; }
        .stat-card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .stat-card .number { font-size: 36px; font-weight: 700; color: #0057A8; }
        .stat-card .label { color: #666; font-size: 14px; margin-top: 4px; }
        .section { background: white; border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
        .section h2 { font-size: 18px; margin-bottom: 16px; color: #333; }
        .send-form { display: flex; flex-direction: column; gap: 12px; }
        .send-form input, .send-form textarea {
            padding: 12px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; width: 100%;
        }
        .send-form textarea { height: 100px; resize: vertical; }
        .send-form button {
            background: #0057A8; color: white; border: none; padding: 12px 24px;
            border-radius: 8px; font-size: 16px; cursor: pointer; width: fit-content;
        }
        .send-form button:hover { background: #004494; }
        table { width: 100%; border-collapse: collapse; }
        th { text-align: left; padding: 10px 12px; background: #f8f9ff; font-size: 13px; color: #666; }
        td { padding: 12px; border-top: 1px solid #f0f0f0; font-size: 14px; }
        .badge { padding: 3px 8px; border-radius: 12px; font-size: 12px; font-weight: 600; }
        .badge.pending { background: #fff3cd; color: #856404; }
        .badge.sent { background: #d1eddc; color: #155724; }
        .badge.failed { background: #f8d7da; color: #721c24; }
        #status { padding: 12px; border-radius: 8px; margin-top: 12px; display: none; }
        #status.success { background: #d1eddc; color: #155724; display: block; }
        #status.error { background: #f8d7da; color: #721c24; display: block; }
        .refresh { font-size: 13px; color: #0057A8; cursor: pointer; text-decoration: underline; float: right; }
    </style>
</head>
<body>
    <header>
        <h1>📱 SMS Gateway Dashboard</h1>
        <p>Administrer innkommende og utgående meldinger</p>
    </header>
    <div class="container">
        <div class="stats" id="stats"></div>

        <div class="section">
            <h2>📤 Send SMS via gateway</h2>
            <div class="send-form">
                <input type="tel" id="sendTo" placeholder="Mottaker (+4712345678)" />
                <textarea id="sendBody" placeholder="Melding..."></textarea>
                <button onclick="sendSms()">Send SMS</button>
                <div id="status"></div>
            </div>
        </div>

        <div class="section">
            <h2>📨 Innkommende meldinger <span class="refresh" onclick="loadInbox()">↻ Oppdater</span></h2>
            <table>
                <thead><tr><th>Fra</th><th>Melding</th><th>Tid</th></tr></thead>
                <tbody id="inboxTable"><tr><td colspan="3">Laster...</td></tr></tbody>
            </table>
        </div>

        <div class="section">
            <h2>✅ Sendte meldinger <span class="refresh" onclick="loadSent()">↻ Oppdater</span></h2>
            <table>
                <thead><tr><th>Til</th><th>Melding</th><th>Status</th><th>Tid</th></tr></thead>
                <tbody id="sentTable"><tr><td colspan="4">Laster...</td></tr></tbody>
            </table>
        </div>
    </div>

<script>
const API_KEY = prompt('Skriv inn API-nøkkel:') || '';

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json', ...options.headers }
    });
    return res.json();
}

function timeAgo(ts) {
    const d = Math.floor((Date.now() - ts) / 1000);
    if (d < 60) return d + 's siden';
    if (d < 3600) return Math.floor(d/60) + 'm siden';
    if (d < 86400) return Math.floor(d/3600) + 't siden';
    return new Date(ts).toLocaleDateString('nb');
}

async function loadStats() {
    const [inbox, sent, pending] = await Promise.all([
        api('/api/sms/inbox?limit=1000'),
        api('/api/sms/sent?limit=1000'),
        api('/api/sms/pending')
    ]);
    document.getElementById('stats').innerHTML = \`
        <div class="stat-card"><div class="number">\${inbox.length}</div><div class="label">Mottatte meldinger</div></div>
        <div class="stat-card"><div class="number">\${sent.length}</div><div class="label">Sendte meldinger</div></div>
        <div class="stat-card"><div class="number">\${pending.length}</div><div class="label">I kø</div></div>
    \`;
}

async function loadInbox() {
    const data = await api('/api/sms/inbox');
    const tbody = document.getElementById('inboxTable');
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="3">Ingen meldinger ennå</td></tr>'; return; }
    tbody.innerHTML = data.map(m => \`
        <tr>
            <td><strong>\${m.from}</strong></td>
            <td>\${m.body}</td>
            <td>\${timeAgo(m.receivedAt)}</td>
        </tr>
    \`).join('');
}

async function loadSent() {
    const data = await api('/api/sms/sent');
    const tbody = document.getElementById('sentTable');
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="4">Ingen sendte meldinger</td></tr>'; return; }
    tbody.innerHTML = data.map(m => \`
        <tr>
            <td><strong>\${m.to}</strong></td>
            <td>\${m.body}</td>
            <td><span class="badge \${m.status}">\${m.status}</span></td>
            <td>\${timeAgo(m.createdAt)}</td>
        </tr>
    \`).join('');
}

async function sendSms() {
    const to = document.getElementById('sendTo').value.trim();
    const body = document.getElementById('sendBody').value.trim();
    const status = document.getElementById('status');
    if (!to || !body) { status.className = 'error'; status.textContent = 'Fyll inn mottaker og melding'; return; }
    const res = await api('/api/sms/send', { method: 'POST', body: JSON.stringify({ to, body }) });
    if (res.success) {
        status.className = 'success';
        status.textContent = '✅ Melding lagt i kø! Gateway-telefonen sender den snart.';
        document.getElementById('sendTo').value = '';
        document.getElementById('sendBody').value = '';
        loadStats();
    } else {
        status.className = 'error';
        status.textContent = '❌ Feil: ' + (res.error || 'Ukjent feil');
    }
}

// Last inn data
loadStats();
loadInbox();
loadSent();
setInterval(() => { loadStats(); loadInbox(); loadSent(); }, 10000);
</script>
</body>
</html>
    `);
});

// ── START SERVER ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 SMS Gateway Server kjører på port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard`);
    console.log(`🔑 API-nøkkel: ${API_KEY}`);
});
