require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

app.use(cors());
app.use(express.json());

// ── DATABASE ──────────────────────────────────────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            api_key TEXT UNIQUE NOT NULL,
            created_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            direction TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            from_number TEXT,
            to_number TEXT,
            body TEXT NOT NULL,
            received_at BIGINT,
            sent_at BIGINT,
            created_at BIGINT NOT NULL,
            source TEXT DEFAULT 'gateway',
            error_message TEXT
        );

        CREATE TABLE IF NOT EXISTS webhooks (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            events TEXT NOT NULL,
            secret TEXT NOT NULL,
            enabled BOOLEAN DEFAULT TRUE,
            created_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rules (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            trigger TEXT NOT NULL,
            response TEXT NOT NULL,
            is_regex BOOLEAN DEFAULT FALSE,
            enabled BOOLEAN DEFAULT TRUE,
            created_at BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_messages_tenant ON messages(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);
        CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS phone_number TEXT;
        ALTER TABLE devices ADD COLUMN IF NOT EXISTS battery_level INT;
        ALTER TABLE devices ADD COLUMN IF NOT EXISTS network_type TEXT;

        CREATE TABLE IF NOT EXISTS reset_codes (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            code TEXT NOT NULL,
            phone TEXT NOT NULL,
            used BOOLEAN DEFAULT FALSE,
            created_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL
        );
    `);
    console.log('Database initialisert');
}

// ── HJELPEFUNKSJONER ──────────────────────────────────────────────────────────
function generateApiKey() {
    return 'sk_' + crypto.randomBytes(24).toString('hex');
}

function slugify(name) {
    return name.toLowerCase()
        .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
        .replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function getTenantByApiKey(apiKey) {
    const res = await pool.query('SELECT * FROM tenants WHERE api_key = $1', [apiKey]);
    return res.rows[0] || null;
}

async function getTenantBySlug(slug) {
    const res = await pool.query('SELECT * FROM tenants WHERE slug = $1', [slug]);
    return res.rows[0] || null;
}

async function getStats(tenantId) {
    const oneDayAgo = Date.now() - 86400000;

    const [inbound, sent, failed, pending, inbound24, sent24] = await Promise.all([
        pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='inbound'", [tenantId]),
        pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='outbound' AND status='sent'", [tenantId]),
        pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND status='failed'", [tenantId]),
        pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND status='pending'", [tenantId]),
        pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='inbound' AND received_at>$2", [tenantId, oneDayAgo]),
        pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='outbound' AND status='sent' AND sent_at>$2", [tenantId, oneDayAgo])
    ]);

    const daily = [];
    for (let i = 6; i >= 0; i--) {
        const start = new Date(); start.setDate(start.getDate() - i); start.setHours(0,0,0,0);
        const end = new Date(start); end.setDate(end.getDate() + 1);
        const [din, dout] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='inbound' AND received_at>=$2 AND received_at<$3", [tenantId, start.getTime(), end.getTime()]),
            pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='outbound' AND status='sent' AND sent_at>=$2 AND sent_at<$3", [tenantId, start.getTime(), end.getTime()])
        ]);
        daily.push({ date: start.toLocaleDateString('nb-NO', {weekday:'short',day:'numeric',month:'short'}), inbound: parseInt(din.rows[0].count), sent: parseInt(dout.rows[0].count) });
    }

    return {
        total: { inbound: parseInt(inbound.rows[0].count), sent: parseInt(sent.rows[0].count), failed: parseInt(failed.rows[0].count), pending: parseInt(pending.rows[0].count) },
        last24h: { inbound: parseInt(inbound24.rows[0].count), sent: parseInt(sent24.rows[0].count) },
        dailyBreakdown: daily
    };
}

async function getContacts(tenantId) {
    const res = await pool.query(`
        SELECT from_number as number, MAX(received_at) as last_seen, COUNT(*) as message_count
        FROM messages WHERE tenant_id=$1 AND direction='inbound' AND from_number IS NOT NULL
        GROUP BY from_number
        UNION
        SELECT to_number as number, MAX(COALESCE(sent_at, created_at)) as last_seen, 0 as message_count
        FROM messages WHERE tenant_id=$1 AND direction='outbound' AND to_number IS NOT NULL
        GROUP BY to_number
        ORDER BY last_seen DESC LIMIT 100
    `, [tenantId]);
    return res.rows.map(r => ({ number: r.number, lastSeen: parseInt(r.last_seen), messageCount: parseInt(r.message_count) }));
}

async function triggerWebhooks(tenantId, event, payload) {
    const res = await pool.query("SELECT * FROM webhooks WHERE tenant_id=$1 AND enabled=TRUE", [tenantId]);
    for (const webhook of res.rows) {
        const events = JSON.parse(webhook.events);
        if (!events.includes(event)) continue;
        try {
            const body = JSON.stringify({ event, payload, timestamp: Date.now() });
            const sig = crypto.createHmac('sha256', webhook.secret).update(body).digest('hex');
            await fetch(webhook.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Gateway-Signature': sig, 'X-Gateway-Event': event }, body });
        } catch (e) { console.error('Webhook feilet:', e.message); }
    }
}

async function checkAutoReply(tenantId, from, body) {
    const res = await pool.query('SELECT * FROM rules WHERE tenant_id=$1 AND enabled=TRUE', [tenantId]);
    for (const rule of res.rows) {
        let match = false;
        if (rule.is_regex) { try { match = new RegExp(rule.trigger, 'i').test(body); } catch {} }
        else { match = body.toLowerCase().includes(rule.trigger.toLowerCase()); }
        if (match) {
            await pool.query(
                'INSERT INTO messages (id,tenant_id,direction,status,to_number,body,created_at,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
                [uuidv4(), tenantId, 'outbound', 'pending', from, rule.response, Date.now(), 'auto-reply']
            );
        }
    }
}

function generateWelcomeMessage(tenant, serverUrl) {
    return `Hei!\n\nDu har nå tilgang til SMS Gateway.\n\nDashboard: ${serverUrl}/kunde/${tenant.slug}/dashboard\nPassord: (det du valgte)\n\nAndroid-app innstillinger:\nServer URL: ${serverUrl}\nAPI-nøkkel: ${tenant.api_key}\n\nTa kontakt ved spørsmål.`;
}

// ── SESSIONS ──────────────────────────────────────────────────────────────────
const adminSessions = {};
const tenantSessions = {};

function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token || !adminSessions[token] || adminSessions[token].expires < Date.now()) return res.status(401).json({ error: 'Ikke innlogget' });
    adminSessions[token].expires = Date.now() + 28800000;
    next();
}

async function requireTenantSession(req, res, next) {
    const token = req.headers['x-session-token'];
    const session = tenantSessions[token];
    if (!token || !session || session.expires < Date.now()) return res.status(401).json({ error: 'Ikke innlogget' });
    session.expires = Date.now() + 28800000;
    const tenant = await pool.query('SELECT * FROM tenants WHERE id=$1', [session.tenantId]);
    if (!tenant.rows[0]) return res.status(401).json({ error: 'Kunde ikke funnet' });
    req.tenant = tenant.rows[0];
    next();
}

async function requireApiKey(req, res, next) {
    const tenant = await getTenantByApiKey(req.headers['x-api-key']);
    if (!tenant) return res.status(401).json({ error: 'Ugyldig API-nøkkel' });
    req.tenant = tenant;
    next();
}

// ── HELSESJEKK ────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', version: '4.0.0', message: 'SMS Gateway Server' }));

// ── ADMIN API ─────────────────────────────────────────────────────────────────
app.post('/admin/login', (req, res) => {
    if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Feil passord' });
    const token = uuidv4();
    adminSessions[token] = { expires: Date.now() + 28800000 };
    res.json({ token });
});

app.get('/admin/tenants', requireAdmin, async (req, res) => {
    const tenants = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    const result = await Promise.all(tenants.rows.map(async t => {
        const [inbound, sent, pending] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND direction='inbound'", [t.id]),
            pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND status='sent'", [t.id]),
            pool.query("SELECT COUNT(*) FROM messages WHERE tenant_id=$1 AND status='pending'", [t.id])
        ]);
        return {
            id: t.id, name: t.name, slug: t.slug, apiKey: t.api_key,
            createdAt: t.created_at, phoneNumber: t.phone_number, maxDevices: t.max_devices || 1,
            stats: { inbound: parseInt(inbound.rows[0].count), sent: parseInt(sent.rows[0].count), pending: parseInt(pending.rows[0].count) }
        };
    }));
    res.json(result);
});

// Rediger kunde
app.put('/admin/tenants/:id', requireAdmin, async (req, res) => {
    const { name, password, phoneNumber, maxDevices } = req.body;
    if (!name) return res.status(400).json({ error: 'Navn påkrevd' });
    const updates = ['name=$1', 'phone_number=$2', 'max_devices=$3'];
    const values = [name, phoneNumber || null, maxDevices || 1];
    if (password && password.length >= 8) {
        updates.push('password=$' + (values.length + 1));
        values.push(password);
    }
    values.push(req.params.id);
    await pool.query(`UPDATE tenants SET ${updates.join(',')} WHERE id=$${values.length}`, values);
    res.json({ success: true });
});

app.post('/admin/tenants', requireAdmin, async (req, res) => {
    const { name, password, phoneNumber, maxDevices } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'name og password er påkrevd' });
    const slug = slugify(name);
    const existing = await getTenantBySlug(slug);
    if (existing) return res.status(400).json({ error: 'Kunde med dette navnet finnes allerede' });

    const tenant = { id: uuidv4(), name, slug, password, api_key: generateApiKey(), created_at: Date.now() };
    await pool.query(
        'INSERT INTO tenants (id,name,slug,password,api_key,created_at,phone_number,max_devices) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [tenant.id, tenant.name, tenant.slug, tenant.password, tenant.api_key, tenant.created_at, phoneNumber || null, maxDevices || 1]
    );

    const serverUrl = req.protocol + '://' + req.get('host');
    const dashboardUrl = `${serverUrl}/kunde/${slug}/dashboard`;
    res.status(201).json({ id: tenant.id, name, slug, apiKey: tenant.api_key, dashboardUrl, welcomeMessage: generateWelcomeMessage(tenant, serverUrl) });
});

app.delete('/admin/tenants/:id', requireAdmin, async (req, res) => {
    await pool.query('DELETE FROM tenants WHERE id=$1', [req.params.id]);
    res.json({ success: true });
});

app.post('/admin/tenants/:id/regenerate-key', requireAdmin, async (req, res) => {
    const newKey = generateApiKey();
    await pool.query('UPDATE tenants SET api_key=$1 WHERE id=$2', [newKey, req.params.id]);
    res.json({ apiKey: newKey });
});

// ── TENANT AUTH ───────────────────────────────────────────────────────────────
app.post('/kunde/:slug/auth/login', async (req, res) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Ikke funnet' });
    if (req.body.password !== tenant.password) return res.status(401).json({ error: 'Feil passord' });
    const token = uuidv4();
    tenantSessions[token] = { tenantId: tenant.id, expires: Date.now() + 28800000 };
    res.json({ token, tenantName: tenant.name });
});

app.post('/kunde/:slug/auth/change-password', requireTenantSession, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (currentPassword !== req.tenant.password) return res.status(401).json({ error: 'Feil passord' });
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Min 8 tegn' });
    await pool.query('UPDATE tenants SET password=$1 WHERE id=$2', [newPassword, req.tenant.id]);
    res.json({ success: true });
});

// Registrer telefonnummer for reset
app.post('/kunde/:slug/auth/register-phone', requireTenantSession, async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Telefonnummer påkrevd' });
    await pool.query('UPDATE tenants SET phone_number=$1 WHERE id=$2', [phoneNumber, req.tenant.id]);
    res.json({ success: true });
});

// Be om reset-kode (kunden ber om kode fra reset-siden)
app.post('/kunde/:slug/auth/request-reset', async (req, res) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Ikke funnet' });
    if (!tenant.phone_number) return res.status(400).json({ error: 'Ingen telefon registrert. Kontakt administrator.' });

    // Generer 6-sifret kode
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutter

    // Slett gamle koder
    await pool.query('DELETE FROM reset_codes WHERE tenant_id=$1', [tenant.id]);

    await pool.query(
        'INSERT INTO reset_codes (id, tenant_id, code, phone, used, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [uuidv4(), tenant.id, code, tenant.phone_number, false, Date.now(), expiresAt]
    );

    // Legg reset-koden i meldingskøen som utgående SMS
    const msgBody = `Ayno Connect: Din reset-kode er ${code}. Gyldig i 15 minutter.`;
    await pool.query(
        'INSERT INTO messages (id,tenant_id,direction,status,to_number,body,created_at,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [uuidv4(), tenant.id, 'outbound', 'pending', tenant.phone_number, msgBody, Date.now(), 'reset']
    );

    res.json({ success: true, maskedPhone: tenant.phone_number.slice(0,-4).replace(/./g,'*') + tenant.phone_number.slice(-4) });
});

// Verifiser reset-kode og sett nytt passord
app.post('/kunde/:slug/auth/verify-reset', async (req, res) => {
    const { code, newPassword } = req.body;
    if (!code || !newPassword) return res.status(400).json({ error: 'Kode og nytt passord påkrevd' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Passord må være minst 8 tegn' });

    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).json({ error: 'Ikke funnet' });

    const reset = await pool.query(
        'SELECT * FROM reset_codes WHERE tenant_id=$1 AND code=$2 AND used=FALSE AND expires_at > $3',
        [tenant.id, code, Date.now()]
    );

    if (!reset.rows[0]) return res.status(401).json({ error: 'Ugyldig eller utløpt kode' });

    await pool.query('UPDATE tenants SET password=$1 WHERE id=$2', [newPassword, tenant.id]);
    await pool.query('UPDATE reset_codes SET used=TRUE WHERE id=$1', [reset.rows[0].id]);

    res.json({ success: true });
});

// ── TENANT API ────────────────────────────────────────────────────────────────
app.get('/kunde/:slug/api/stats', requireTenantSession, async (req, res) => {
    res.json(await getStats(req.tenant.id));
});

app.get('/kunde/:slug/api/contacts', requireTenantSession, async (req, res) => {
    res.json(await getContacts(req.tenant.id));
});

app.get('/kunde/:slug/api/sms/inbox', requireTenantSession, async (req, res) => {
    const { limit = 100, search = '' } = req.query;
    let query = "SELECT * FROM messages WHERE tenant_id=$1 AND direction='inbound'";
    const params = [req.tenant.id];
    if (search) { query += ' AND (from_number ILIKE $2 OR body ILIKE $2)'; params.push('%' + search + '%'); }
    query += ' ORDER BY received_at DESC LIMIT ' + parseInt(limit);
    const res2 = await pool.query(query, params);
    res.json(res2.rows.map(m => ({ id: m.id, from: m.from_number, body: m.body, receivedAt: parseInt(m.received_at) })));
});

app.get('/kunde/:slug/api/sms/sent', requireTenantSession, async (req, res) => {
    const { limit = 100, search = '' } = req.query;
    let query = "SELECT * FROM messages WHERE tenant_id=$1 AND direction='outbound' AND status='sent'";
    const params = [req.tenant.id];
    if (search) { query += ' AND (to_number ILIKE $2 OR body ILIKE $2)'; params.push('%' + search + '%'); }
    query += ' ORDER BY sent_at DESC LIMIT ' + parseInt(limit);
    const res2 = await pool.query(query, params);
    res.json(res2.rows.map(m => ({ id: m.id, to: m.to_number, body: m.body, sentAt: parseInt(m.sent_at), createdAt: parseInt(m.created_at) })));
});

app.post('/kunde/:slug/api/sms/send', requireTenantSession, async (req, res) => {
    const { to, body } = req.body;
    if (!to || !body) return res.status(400).json({ error: 'to og body er påkrevd' });
    const id = uuidv4();
    await pool.query('INSERT INTO messages (id,tenant_id,direction,status,to_number,body,created_at,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, req.tenant.id, 'outbound', 'pending', to, body, Date.now(), 'dashboard']);
    res.status(201).json({ success: true, id });
});

app.get('/kunde/:slug/api/export/inbox', requireTenantSession, async (req, res) => {
    const result = await pool.query("SELECT * FROM messages WHERE tenant_id=$1 AND direction='inbound' ORDER BY received_at DESC", [req.tenant.id]);
    const csv = ['Fra,Melding,Mottatt'].concat(result.rows.map(m => `"${m.from_number}","${(m.body||'').replace(/"/g,'""')}","${new Date(parseInt(m.received_at)).toLocaleString('nb-NO')}"`)).join('\n');
    res.setHeader('Content-Type','text/csv;charset=utf-8'); res.setHeader('Content-Disposition','attachment;filename="innkommende.csv"'); res.send('\ufeff'+csv);
});

app.get('/kunde/:slug/api/export/sent', requireTenantSession, async (req, res) => {
    const result = await pool.query("SELECT * FROM messages WHERE tenant_id=$1 AND direction='outbound' AND status='sent' ORDER BY sent_at DESC", [req.tenant.id]);
    const csv = ['Til,Melding,Sendt'].concat(result.rows.map(m => `"${m.to_number}","${(m.body||'').replace(/"/g,'""')}","${new Date(parseInt(m.sent_at||m.created_at)).toLocaleString('nb-NO')}"`)).join('\n');
    res.setHeader('Content-Type','text/csv;charset=utf-8'); res.setHeader('Content-Disposition','attachment;filename="sendte.csv"'); res.send('\ufeff'+csv);
});

// Webhooks
app.get('/kunde/:slug/api/webhooks', requireTenantSession, async (req, res) => {
    const result = await pool.query('SELECT * FROM webhooks WHERE tenant_id=$1 ORDER BY created_at DESC', [req.tenant.id]);
    res.json(result.rows.map(w => ({ ...w, events: JSON.parse(w.events) })));
});
app.post('/kunde/:slug/api/webhooks', requireTenantSession, async (req, res) => {
    const { url, events, secret } = req.body;
    if (!url || !events?.length) return res.status(400).json({ error: 'url og events påkrevd' });
    const id = uuidv4();
    await pool.query('INSERT INTO webhooks (id,tenant_id,url,events,secret,enabled,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, req.tenant.id, url, JSON.stringify(events), secret || uuidv4(), true, Date.now()]);
    res.status(201).json({ id, url, events, enabled: true });
});
app.put('/kunde/:slug/api/webhooks/:id', requireTenantSession, async (req, res) => {
    const { enabled } = req.body;
    await pool.query('UPDATE webhooks SET enabled=$1 WHERE id=$2 AND tenant_id=$3', [enabled, req.params.id, req.tenant.id]);
    res.json({ success: true });
});
app.delete('/kunde/:slug/api/webhooks/:id', requireTenantSession, async (req, res) => {
    await pool.query('DELETE FROM webhooks WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
    res.json({ success: true });
});

// Regler
app.get('/kunde/:slug/api/rules', requireTenantSession, async (req, res) => {
    const result = await pool.query('SELECT * FROM rules WHERE tenant_id=$1 ORDER BY created_at DESC', [req.tenant.id]);
    res.json(result.rows);
});
app.post('/kunde/:slug/api/rules', requireTenantSession, async (req, res) => {
    const { name, trigger, response, isRegex = false } = req.body;
    if (!name || !trigger || !response) return res.status(400).json({ error: 'Alle felter påkrevd' });
    const id = uuidv4();
    await pool.query('INSERT INTO rules (id,tenant_id,name,trigger,response,is_regex,enabled,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, req.tenant.id, name, trigger, response, isRegex, true, Date.now()]);
    res.status(201).json({ id, name, trigger, response, is_regex: isRegex, enabled: true });
});
app.put('/kunde/:slug/api/rules/:id', requireTenantSession, async (req, res) => {
    const { enabled } = req.body;
    await pool.query('UPDATE rules SET enabled=$1 WHERE id=$2 AND tenant_id=$3', [enabled, req.params.id, req.tenant.id]);
    res.json({ success: true });
});
app.delete('/kunde/:slug/api/rules/:id', requireTenantSession, async (req, res) => {
    await pool.query('DELETE FROM rules WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
    res.json({ success: true });
});

// ── ANDROID APP API ───────────────────────────────────────────────────────────
app.post('/api/sms/inbound', requireApiKey, async (req, res) => {
    const { from, body, timestamp, receivedAt } = req.body;
    if (!from || !body) return res.status(400).json({ error: 'from og body påkrevd' });
    const id = uuidv4();
    const ts = receivedAt || Date.now();
    await pool.query('INSERT INTO messages (id,tenant_id,direction,status,from_number,body,received_at,created_at,source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, req.tenant.id, 'inbound', 'received', from, body, ts, ts, 'gateway']);
    await triggerWebhooks(req.tenant.id, 'sms.received', { id, from, body, receivedAt: ts });
    await checkAutoReply(req.tenant.id, from, body);
    console.log(`[${req.tenant.name}] SMS fra ${from}`);
    res.json({ success: true, id });
});

app.get('/api/sms/pending', requireApiKey, async (req, res) => {
    const result = await pool.query("SELECT * FROM messages WHERE tenant_id=$1 AND status='pending' AND direction='outbound' ORDER BY created_at ASC", [req.tenant.id]);
    res.json(result.rows.map(m => ({ id: m.id, to: m.to_number, body: m.body })));
});

app.post('/api/sms/:id/status', requireApiKey, async (req, res) => {
    const { success, sentAt, errorMessage } = req.body;
    if (success) {
        await pool.query("UPDATE messages SET status='sent', sent_at=$1 WHERE id=$2 AND tenant_id=$3", [sentAt || Date.now(), req.params.id, req.tenant.id]);
        const msg = await pool.query('SELECT * FROM messages WHERE id=$1', [req.params.id]);
        if (msg.rows[0]) await triggerWebhooks(req.tenant.id, 'sms.sent', msg.rows[0]);
    } else {
        await pool.query("UPDATE messages SET status='failed', error_message=$1 WHERE id=$2 AND tenant_id=$3", [errorMessage, req.params.id, req.tenant.id]);
    }
    res.json({ success: true });
});

app.post('/api/device/fcm-token', requireApiKey, (req, res) => {
    res.json({ success: true });
});

// Gateway ping — appen kaller dette hvert minutt for å vise at den er online
app.post('/api/gateway/ping', requireApiKey, async (req, res) => {
    const deviceId = req.headers['x-device-id'];
    const { batteryLevel, networkType } = req.body;
    if (deviceId) {
        await pool.query(
            'UPDATE devices SET last_seen=$1 WHERE tenant_id=$2 AND device_id=$3',
            [Date.now(), req.tenant.id, deviceId]
        );
        // Lagre ekstra status-info
        await pool.query(
            `UPDATE devices SET battery_level=$1, network_type=$2 WHERE tenant_id=$3 AND device_id=$4`,
            [batteryLevel || null, networkType || null, req.tenant.id, deviceId]
        ).catch(() => {}); // Ignorer hvis kolonnene ikke finnes ennå
    }
    res.json({ success: true, serverTime: Date.now() });
});

// Admin: hent gateway-status for alle kunder
app.get('/admin/gateway-status', requireAdmin, async (req, res) => {
    const devices = await pool.query(`
        SELECT d.*, t.name as tenant_name, t.slug,
               (SELECT COUNT(*) FROM messages WHERE tenant_id=d.tenant_id AND status='pending' AND direction='outbound') as pending_count,
               (SELECT MAX(received_at) FROM messages WHERE tenant_id=d.tenant_id AND direction='inbound') as last_inbound,
               (SELECT MAX(sent_at) FROM messages WHERE tenant_id=d.tenant_id AND direction='outbound' AND status='sent') as last_sent
        FROM devices d
        JOIN tenants t ON t.id = d.tenant_id
        ORDER BY d.last_seen DESC NULLS LAST
    `);
    res.json(devices.rows);
});

// ── DASHBOARDS ────────────────────────────────────────────────────────────────
app.use(express.static('public'));
app.get('/admin', (req, res) => res.sendFile(__dirname + '/public/admin.html'));
app.get('/kunde/:slug/dashboard', async (req, res) => {
    const tenant = await getTenantBySlug(req.params.slug);
    if (!tenant) return res.status(404).send('<h1 style="font-family:sans-serif;padding:40px">Kunde ikke funnet</h1>');
    res.sendFile(__dirname + '/public/dashboard.html');
});

// ── TENANT DASHBOARD HTML ─────────────────────────────────────────────────────
function tenantDashboard_UNUSED() {
    return `<!DOCTYPE html><html lang="no"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMS Gateway Admin</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}.login{display:flex;align-items:center;justify-content:center;min-height:100vh}.login-box{background:#1e293b;border-radius:16px;padding:40px;width:380px;text-align:center}.login-box h1{font-size:24px;margin-bottom:6px;color:#f8fafc}.login-box p{color:#94a3b8;margin-bottom:24px;font-size:14px}input{width:100%;padding:12px;background:#0f172a;border:1px solid #334155;border-radius:8px;color:#f8fafc;font-size:14px;margin-bottom:12px}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}.btn-primary{background:#3b82f6;color:white;width:100%}.btn-danger{background:#ef4444;color:white}.btn-green{background:#22c55e;color:white}.btn-gray{background:#334155;color:#e2e8f0}.btn-sm{padding:6px 12px;font-size:12px}.btn:hover{opacity:0.9}header{background:#1e293b;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #334155}.server-status{display:flex;align-items:center;gap:8px;font-size:13px;color:#94a3b8}.status-dot{width:8px;height:8px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}.status-dot.offline{background:#ef4444;animation:none}@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}header h1{font-size:18px;color:#f8fafc}.container{max-width:1100px;margin:32px auto;padding:0 16px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:32px}.stat{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155}.stat .num{font-size:32px;font-weight:700;color:#3b82f6}.stat .lbl{color:#94a3b8;font-size:13px;margin-top:4px}.card{background:#1e293b;border-radius:12px;padding:24px;border:1px solid #334155;margin-bottom:24px}.card h2{font-size:16px;font-weight:600;margin-bottom:16px;color:#f8fafc}.form-row{display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end;margin-bottom:12px}.form-group{display:flex;flex-direction:column;gap:6px}.form-group label{font-size:13px;color:#94a3b8}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 12px;background:#0f172a;font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase}td{padding:12px;border-top:1px solid #334155;font-size:14px}code{background:#0f172a;padding:3px 8px;border-radius:4px;font-size:11px;color:#7dd3fc;word-break:break-all}.welcome-box{background:#0f172a;border:1px solid #22c55e;border-radius:10px;padding:16px;margin-top:16px}.welcome-text{font-family:monospace;font-size:13px;color:#cbd5e1;white-space:pre-wrap;line-height:1.6;margin:8px 0}.hidden{display:none}#toast{position:fixed;bottom:24px;right:24px;padding:12px 20px;border-radius:8px;opacity:0;transition:opacity 0.3s;z-index:999;font-size:14px;font-weight:500}#toast.show{opacity:1}</style></head>
<body>
<div id="loginView" class="login"><div class="login-box"><h1>🔐 SMS Gateway</h1><p>Admin-panel</p><input type="password" id="adminPwd" placeholder="Admin-passord" onkeydown="if(event.key==='Enter')adminLogin()"><button class="btn btn-primary" onclick="adminLogin()">Logg inn</button><div id="loginErr" style="color:#f87171;margin-top:8px;font-size:13px"></div></div></div>
<div id="adminView" class="hidden">
<header>
  <div style="display:flex;align-items:center;gap:16px"><h1>🔧 SMS Gateway Admin</h1><div class="server-status"><div class="status-dot" id="statusDot"></div><span id="statusText">Sjekker...</span></div></div>
  <button class="btn btn-danger btn-sm" onclick="adminLogout()">Logg ut</button>
</header>
<div class="container">
<div class="stats" id="adminStats"></div>
<div class="card"><h2>➕ Opprett ny kunde</h2>
<div class="form-row"><div class="form-group"><label>Firmanavn</label><input type="text" id="newName" placeholder="F.eks. Firma AS"></div><div class="form-group"><label>Passord til dashboard</label><input type="password" id="newPwd" placeholder="Minimum 8 tegn"></div><button class="btn btn-green" onclick="createTenant()">Opprett</button></div>
<div id="welcomeResult" class="hidden"><div class="welcome-box"><div style="color:#4ade80;font-weight:600;margin-bottom:8px">✅ Kunde opprettet! Send denne meldingen til kunden:</div><div class="welcome-text" id="welcomeText"></div><div style="display:flex;gap:8px;margin-top:10px"><button class="btn btn-gray btn-sm" onclick="copyWelcome()">📋 Kopier melding</button><a id="dashLink" href="#" target="_blank" class="btn btn-primary btn-sm" style="text-decoration:none;padding:6px 12px;font-size:12px">🔗 Åpne dashboard</a></div></div></div>
</div>
<div class="card"><h2>👥 Kunder</h2>
<table><thead><tr><th>Firma</th><th>Dashboard</th><th>API-nøkkel</th><th>Statistikk</th><th>Handlinger</th></tr></thead><tbody id="tenantsTable"></tbody></table>
</div></div></div>
<div id="toast"></div>
<script>
let adminToken=localStorage.getItem('admin_token')||'';
const BASE=window.location.origin;
let lastWelcome='';
function adminApi(p,o={}){return fetch(BASE+p,{...o,headers:{'Content-Type':'application/json','X-Admin-Token':adminToken,...(o.headers||{})}}).then(r=>r.json());}
async function adminLogin(){const pwd=document.getElementById('adminPwd').value;const res=await fetch(BASE+'/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})}).then(r=>r.json());if(res.token){adminToken=res.token;localStorage.setItem('admin_token',adminToken);document.getElementById('loginView').classList.add('hidden');document.getElementById('adminView').classList.remove('hidden');init();}else{document.getElementById('loginErr').textContent='Feil passord';}}
function adminLogout(){localStorage.removeItem('admin_token');location.reload();}
async function checkServerStatus(){try{const res=await fetch(BASE+'/');const ok=res.ok;document.getElementById('statusDot').className='status-dot'+(ok?'':' offline');document.getElementById('statusText').textContent=ok?'Server kjører':'Server utilgjengelig';}catch{document.getElementById('statusDot').className='status-dot offline';document.getElementById('statusText').textContent='Server utilgjengelig';}}
async function loadTenants(){const data=await adminApi('/admin/tenants');const tot=data.reduce((a,t)=>({i:a.i+t.stats.inbound,s:a.s+t.stats.sent}),{i:0,s:0});document.getElementById('adminStats').innerHTML='<div class="stat"><div class="num">'+data.length+'</div><div class="lbl">Aktive kunder</div></div><div class="stat"><div class="num">'+tot.i+'</div><div class="lbl">Totalt innkommende</div></div><div class="stat"><div class="num">'+tot.s+'</div><div class="lbl">Totalt sendte</div></div>';document.getElementById('tenantsTable').innerHTML=data.length?data.map(t=>'<tr><td><strong>'+t.name+'</strong><br><span style="color:#64748b;font-size:12px">'+new Date(t.createdAt).toLocaleDateString('nb-NO')+'</span></td><td><a href="/kunde/'+t.slug+'/dashboard" target="_blank" style="color:#7dd3fc;font-size:13px">/kunde/'+t.slug+'</a></td><td><code>'+t.apiKey+'</code></td><td><span style="color:#4ade80">↓'+t.stats.inbound+'</span> <span style="color:#60a5fa">↑'+t.stats.sent+'</span>'+(t.stats.pending>0?' <span style="color:#fbbf24">⏳'+t.stats.pending+'</span>':'')+'</td><td><div style="display:flex;gap:6px"><button class="btn btn-gray btn-sm" onclick="regenKey(\''+t.id+'\',\''+t.name+'\')">🔑 Ny nøkkel</button><button class="btn btn-danger btn-sm" onclick="deleteTenant(\''+t.id+'\',\''+t.name+'\')">🗑 Slett</button></div></td></tr>').join(''):'<tr><td colspan="5" style="text-align:center;color:#64748b;padding:32px">Ingen kunder ennå</td></tr>';}
async function createTenant(){const name=document.getElementById('newName').value.trim(),password=document.getElementById('newPwd').value;if(!name){toast('Skriv firmanavn',false);return;}if(!password||password.length<8){toast('Passord min 8 tegn',false);return;}const res=await adminApi('/admin/tenants',{method:'POST',body:JSON.stringify({name,password})});if(res.id){lastWelcome=res.welcomeMessage;document.getElementById('welcomeText').textContent=res.welcomeMessage;document.getElementById('dashLink').href=res.dashboardUrl;document.getElementById('welcomeResult').classList.remove('hidden');document.getElementById('newName').value='';document.getElementById('newPwd').value='';await loadTenants();toast('Kunde opprettet!');}else{toast(res.error||'Feil',false);}}
function copyWelcome(){navigator.clipboard.writeText(lastWelcome).then(()=>toast('Kopiert!'));}
async function deleteTenant(id,name){if(!confirm('Slette '+name+'? Alle meldinger slettes permanent.'))return;await adminApi('/admin/tenants/'+id,{method:'DELETE'});document.getElementById('welcomeResult').classList.add('hidden');await loadTenants();toast('Slettet');}
async function regenKey(id,name){if(!confirm('Ny API-nøkkel for '+name+'?'))return;const res=await adminApi('/admin/tenants/'+id+'/regenerate-key',{method:'POST'});toast('Ny nøkkel: '+res.apiKey);await loadTenants();}
function toast(msg,ok=true){const t=document.getElementById('toast');t.textContent=msg;t.style.background=ok?'#22c55e':'#ef4444';t.style.color='white';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}
async function init(){checkServerStatus();await loadTenants();setInterval(()=>{checkServerStatus();loadTenants();},10000);}
async function checkAdminSession(){if(!adminToken)return;const res=await adminApi('/admin/tenants').catch(()=>null);if(res&&!res.error){document.getElementById('loginView').classList.add('hidden');document.getElementById('adminView').classList.remove('hidden');init();}else{localStorage.removeItem('admin_token');}}
checkAdminSession();
</script></body></html>`;
}

// ── TENANT DASHBOARD HTML ─────────────────────────────────────────────────────
function tenantDashboard(tenant, slug) {
    return `<!DOCTYPE html><html lang="no"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SMS Gateway - ${tenant.name}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f4f8;color:#1a202c}.login-overlay{position:fixed;inset:0;background:linear-gradient(135deg,#0057A8,#0096c7);display:flex;align-items:center;justify-content:center;z-index:1000}.login-box{background:white;border-radius:20px;padding:48px 40px;width:380px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3)}.login-logo{font-size:48px;margin-bottom:12px}.login-box h1{font-size:22px;margin-bottom:4px}.login-box p{color:#718096;margin-bottom:28px;font-size:14px}.login-box input{width:100%;padding:14px;border:2px solid #e2e8f0;border-radius:10px;font-size:15px;margin-bottom:12px;color:#1a202c;transition:border-color 0.2s}.login-box input:focus{outline:none;border-color:#0057A8}.login-btn{width:100%;padding:14px;background:#0057A8;color:white;border:none;border-radius:10px;font-size:16px;font-weight:600;cursor:pointer}header{background:white;padding:0 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;height:64px;box-shadow:0 1px 3px rgba(0,0,0,0.06)}.header-left{display:flex;align-items:center;gap:12px}header h1{font-size:17px;font-weight:700}.header-subtitle{font-size:12px;color:#718096}.header-right button{background:#f7fafc;color:#4a5568;border:1px solid #e2e8f0;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px}nav{background:white;border-bottom:1px solid #e2e8f0;display:flex;padding:0 24px;overflow-x:auto;gap:4px}nav button{padding:16px 16px 14px;border:none;background:none;cursor:pointer;font-size:14px;color:#718096;border-bottom:3px solid transparent;white-space:nowrap;font-weight:500}nav button.active{color:#0057A8;border-bottom-color:#0057A8;font-weight:600}.container{max-width:1200px;margin:28px auto;padding:0 20px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:16px;margin-bottom:28px}.stat{background:white;border-radius:14px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,0.06);border:1px solid #f0f4f8}.stat .num{font-size:30px;font-weight:800;color:#0057A8;line-height:1}.stat .lbl{color:#a0aec0;font-size:12px;margin-top:6px;font-weight:500;text-transform:uppercase;letter-spacing:0.5px}.stat .trend{font-size:12px;margin-top:4px;color:#48BB78}.card{background:white;border-radius:14px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,0.06);margin-bottom:20px;border:1px solid #f0f4f8}.card h2{font-size:16px;font-weight:700;margin-bottom:16px;color:#2d3748}.toolbar{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center}.search-box{flex:1;min-width:200px;max-width:300px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:10px;font-size:14px}.send-form{display:grid;grid-template-columns:1fr 1fr;gap:24px}.form-label{font-size:13px;font-weight:600;color:#4a5568;margin-bottom:8px;display:block}.recipient-input-wrap{position:relative}.recipient-input{width:100%;padding:14px 16px;border:2px solid #e2e8f0;border-radius:10px;font-size:15px;color:#1a202c;transition:border-color 0.2s}.recipient-input:focus{outline:none;border-color:#0057A8;box-shadow:0 0 0 3px rgba(0,87,168,0.1)}.contact-dropdown{position:absolute;top:100%;left:0;right:0;background:white;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,0.12);z-index:100;max-height:240px;overflow-y:auto;margin-top:4px}.contact-item{padding:12px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #f7fafc}.contact-item:hover{background:#f0f4f8}.contact-number{font-weight:600;font-size:14px;color:#2d3748}.contact-meta{font-size:12px;color:#a0aec0}.message-area{width:100%;padding:14px 16px;border:2px solid #e2e8f0;border-radius:10px;font-size:15px;resize:vertical;min-height:120px;color:#1a202c;font-family:inherit;transition:border-color 0.2s;line-height:1.5}.message-area:focus{outline:none;border-color:#0057A8;box-shadow:0 0 0 3px rgba(0,87,168,0.1)}.char-count{font-size:12px;color:#a0aec0;text-align:right;margin-top:6px}.send-btn{width:100%;padding:16px;background:#0057A8;color:white;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;transition:all 0.2s;display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px}.send-btn:hover{background:#004494;transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,87,168,0.3)}.send-btn:disabled{background:#a0aec0;transform:none;box-shadow:none}.send-status{margin-top:12px;padding:12px;border-radius:8px;font-size:14px;text-align:center}.send-status.success{background:#f0fff4;color:#276749;border:1px solid #c6f6d5}.send-status.error{background:#fff5f5;color:#9b2c2c;border:1px solid #fed7d7}.contacts-list{border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;max-height:400px;overflow-y:auto}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 16px;background:#f7fafc;font-size:11px;color:#a0aec0;font-weight:700;text-transform:uppercase;letter-spacing:0.5px}td{padding:14px 16px;border-top:1px solid #f7fafc;font-size:14px;vertical-align:middle}tr:hover td{background:#fafbff}.badge{padding:4px 10px;border-radius:20px;font-size:11px;font-weight:700}.badge-green{background:#f0fff4;color:#276749}.chart-bar{height:180px;display:flex;align-items:flex-end;gap:6px;padding:8px 0}.bar-group{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px}.bar-wrap{width:100%;display:flex;gap:3px;align-items:flex-end;height:140px}.bar{flex:1;border-radius:6px 6px 0 0;min-height:3px;transition:height 0.5s ease}.bar.inbound{background:#0057A8}.bar.sent{background:#48BB78}.bar-label{font-size:10px;color:#a0aec0;text-align:center}.legend{display:flex;gap:16px;margin-top:12px}.legend-item{display:flex;align-items:center;gap:6px;font-size:12px;color:#718096}.legend-dot{width:10px;height:10px;border-radius:50%}.tab-content{display:none}.tab-content.active{display:block}.switch{position:relative;display:inline-block;width:44px;height:24px}.switch input{opacity:0;width:0;height:0}.slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e0;border-radius:24px;transition:.3s}.slider:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.3s}.input:checked+.slider{background:#0057A8}.input:checked+.slider:before{transform:translateX(20px)}.form-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}.form-group{display:flex;flex-direction:column;gap:6px}.form-group label{font-size:13px;font-weight:600;color:#4a5568}.form-group input,.form-group textarea{padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;color:#1a202c}.form-group textarea{height:80px;resize:vertical}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}.btn-primary{background:#0057A8;color:white}.btn-danger{background:#fc8181;color:#9b2c2c}.btn-outline{background:white;border:1px solid #e2e8f0;color:#4a5568}.btn-sm{padding:6px 14px;font-size:12px}.btn:hover{opacity:0.85}.hidden{display:none}#toast{position:fixed;bottom:28px;right:28px;padding:14px 20px;border-radius:10px;font-size:14px;font-weight:500;opacity:0;transition:opacity 0.3s;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.15)}#toast.show{opacity:1}@media(max-width:700px){.send-form{grid-template-columns:1fr}}</style></head>
<body>
<div class="login-overlay" id="loginOverlay"><div class="login-box"><div class="login-logo">📱</div><h1>SMS Gateway</h1><p>${tenant.name}</p><input type="password" id="loginPwd" placeholder="Passord" onkeydown="if(event.key==='Enter')login()"><button class="login-btn" onclick="login()">Logg inn</button><div id="loginErr" style="color:#e53e3e;margin-top:10px;font-size:13px"></div></div></div>
<div id="app" class="hidden">
<header><div class="header-left"><span style="font-size:24px">📱</span><div><h1>SMS Gateway</h1><div class="header-subtitle">${tenant.name}</div></div></div><div class="header-right"><button onclick="logout()">Logg ut</button></div></header>
<nav><button class="active" onclick="switchTab('overview',this)">📊 Oversikt</button><button onclick="switchTab('send',this)">✉️ Send SMS</button><button onclick="switchTab('inbox',this)">📨 Innkommende</button><button onclick="switchTab('sent',this)">✅ Sendte</button><button onclick="switchTab('webhooks',this)">🔗 Webhooks</button><button onclick="switchTab('rules',this)">🤖 Auto-svar</button><button onclick="switchTab('settings',this)">⚙️ Innstillinger</button></nav>
<div class="container">
<div id="tab-overview" class="tab-content active"><div class="stats" id="statsGrid"></div><div class="card"><h2>Meldinger siste 7 dager</h2><div class="chart-bar" id="chart"></div><div class="legend"><div class="legend-item"><div class="legend-dot" style="background:#0057A8"></div>Innkommende</div><div class="legend-item"><div class="legend-dot" style="background:#48BB78"></div>Sendte</div></div></div></div>
<div id="tab-send" class="tab-content"><div class="card"><h2>✉️ Send ny SMS</h2><div class="send-form"><div><label class="form-label">Mottaker</label><div class="recipient-input-wrap"><input type="tel" id="sendTo" class="recipient-input" placeholder="+47 xxx xx xxx" oninput="filterContacts(this.value)" onfocus="showContacts()" onblur="setTimeout(hideContacts,200)"><div class="contact-dropdown hidden" id="contactDropdown"></div></div><div style="margin-top:20px"><label class="form-label">Melding</label><textarea id="sendBody" class="message-area" placeholder="Skriv meldingen din her..." oninput="updateCharCount()"></textarea><div class="char-count" id="charCount">0 tegn</div></div><button class="send-btn" id="sendBtn" onclick="sendSms()"><span>📤</span> Send SMS</button><div id="sendStatus" class="hidden send-status"></div></div><div><label class="form-label">📋 Tidligere kontakter</label><div class="contacts-list" id="contactsList"></div><div style="margin-top:10px;font-size:12px;color:#a0aec0">Klikk for å velge mottaker</div></div></div></div></div>
<div id="tab-inbox" class="tab-content"><div class="card"><h2>Innkommende meldinger</h2><div class="toolbar"><input type="text" class="search-box" id="inboxSearch" placeholder="🔍 Søk..." oninput="loadInbox()"><button class="btn btn-outline" id="inboxExport">⬇ CSV</button><button class="btn btn-outline" onclick="loadInbox()">↻ Oppdater</button></div><table><thead><tr><th>Fra</th><th>Melding</th><th>Tidspunkt</th><th></th></tr></thead><tbody id="inboxTable"></tbody></table></div></div>
<div id="tab-sent" class="tab-content"><div class="card"><h2>Sendte meldinger</h2><div class="toolbar"><input type="text" class="search-box" id="sentSearch" placeholder="🔍 Søk..." oninput="loadSent()"><button class="btn btn-outline" id="sentExport">⬇ CSV</button><button class="btn btn-outline" onclick="loadSent()">↻ Oppdater</button></div><table><thead><tr><th>Til</th><th>Melding</th><th>Status</th><th>Tidspunkt</th></tr></thead><tbody id="sentTable"></tbody></table></div></div>
<div id="tab-webhooks" class="tab-content"><div class="card"><h2>Legg til webhook</h2><div class="form-row"><div class="form-group"><label>URL</label><input type="url" id="webhookUrl" placeholder="https://ditt-system.no/webhook"></div><div class="form-group"><label>Hemmelig nøkkel (valgfri)</label><input type="text" id="webhookSecret"></div></div><div class="form-group" style="margin-bottom:16px"><label>Hendelser</label><div style="display:flex;gap:20px;margin-top:8px;font-size:14px"><label><input type="checkbox" value="sms.received" checked> Innkommende</label><label><input type="checkbox" value="sms.sent" checked> Sendt</label><label><input type="checkbox" value="sms.failed"> Mislykket</label></div></div><button class="btn btn-primary" onclick="addWebhook()">Legg til</button></div><div class="card"><h2>Aktive webhooks</h2><table><thead><tr><th>URL</th><th>Hendelser</th><th>Status</th><th></th></tr></thead><tbody id="webhooksTable"></tbody></table></div></div>
<div id="tab-rules" class="tab-content"><div class="card"><h2>Ny auto-svar regel</h2><div class="form-row"><div class="form-group"><label>Navn</label><input type="text" id="ruleName" placeholder="F.eks. Velkomstmelding"></div><div class="form-group"><label>Trigger</label><input type="text" id="ruleTrigger" placeholder="F.eks. HJELP"></div></div><div class="form-group" style="margin-bottom:12px"><label>Svar</label><textarea id="ruleResponse" placeholder="Automatisk svar..."></textarea></div><label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:14px"><input type="checkbox" id="ruleIsRegex"> Bruk regex</label><button class="btn btn-primary" onclick="addRule()">Lagre</button></div><div class="card"><h2>Aktive regler</h2><table><thead><tr><th>Navn</th><th>Trigger</th><th>Svar</th><th>Aktiv</th><th></th></tr></thead><tbody id="rulesTable"></tbody></table></div></div>
<div id="tab-settings" class="tab-content"><div class="card" style="max-width:480px"><h2>🔑 Bytt passord</h2><div class="form-group" style="margin-bottom:12px"><label>Nåværende passord</label><input type="password" id="curPwd"></div><div class="form-group" style="margin-bottom:12px"><label>Nytt passord</label><input type="password" id="newPwdField" placeholder="Minimum 8 tegn"></div><div class="form-group" style="margin-bottom:16px"><label>Bekreft nytt passord</label><input type="password" id="cfmPwd"></div><button class="btn btn-primary" onclick="changePassword()">Lagre</button><div id="pwdStatus" style="margin-top:12px;font-size:14px"></div></div></div>
</div></div>
<div id="toast"></div>
<script>
const SLUG='${slug}',BASE=window.location.origin;
let token=localStorage.getItem('sms_token_'+SLUG)||'',allContacts=[];
function api(p,o={}){return fetch(BASE+'/kunde/'+SLUG+p,{...o,headers:{'Content-Type':'application/json','X-Session-Token':token,...(o.headers||{})}}).then(r=>r.json());}
async function login(){const pwd=document.getElementById('loginPwd').value;const res=await fetch(BASE+'/kunde/'+SLUG+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})}).then(r=>r.json());if(res.token){token=res.token;localStorage.setItem('sms_token_'+SLUG,token);document.getElementById('loginOverlay').style.display='none';document.getElementById('app').classList.remove('hidden');init();}else{document.getElementById('loginErr').textContent='Feil passord';}}
function logout(){localStorage.removeItem('sms_token_'+SLUG);location.reload();}
function switchTab(n,btn){document.querySelectorAll('.tab-content').forEach(t=>t.classList.remove('active'));document.querySelectorAll('nav button').forEach(b=>b.classList.remove('active'));document.getElementById('tab-'+n).classList.add('active');btn.classList.add('active');if(n==='inbox')loadInbox();if(n==='sent')loadSent();if(n==='webhooks')loadWebhooks();if(n==='rules')loadRules();if(n==='overview')loadStats();if(n==='send')loadContactsList();}
function timeAgo(ts){const d=Math.floor((Date.now()-ts)/1000);if(d<60)return d+'s siden';if(d<3600)return Math.floor(d/60)+'m siden';if(d<86400)return Math.floor(d/3600)+'t siden';return new Date(ts).toLocaleString('nb-NO');}
function toast(msg,ok=true){const t=document.getElementById('toast');t.textContent=msg;t.style.background=ok?'#1a202c':'#e53e3e';t.style.color='white';t.classList.add('show');setTimeout(()=>t.classList.remove('show'),3000);}
async function loadStats(){const s=await api('/api/stats');document.getElementById('statsGrid').innerHTML='<div class="stat"><div class="num">'+s.total.inbound+'</div><div class="lbl">Totalt innkommende</div><div class="trend">↑ '+s.last24h.inbound+' siste 24t</div></div><div class="stat"><div class="num">'+s.total.sent+'</div><div class="lbl">Totalt sendte</div><div class="trend">↑ '+s.last24h.sent+' siste 24t</div></div><div class="stat"><div class="num">'+s.last24h.inbound+'</div><div class="lbl">Innkommende 24t</div></div><div class="stat"><div class="num">'+s.total.pending+'</div><div class="lbl">I kø</div></div>';const max=Math.max(...s.dailyBreakdown.map(d=>Math.max(d.inbound,d.sent)),1);document.getElementById('chart').innerHTML=s.dailyBreakdown.map(d=>'<div class="bar-group"><div class="bar-wrap"><div class="bar inbound" style="height:'+Math.max(d.inbound/max*100,2)+'%"></div><div class="bar sent" style="height:'+Math.max(d.sent/max*100,2)+'%"></div></div><div class="bar-label">'+d.date+'</div></div>').join('');}
async function loadContactsList(){allContacts=await api('/api/contacts');renderContactsList(allContacts);}
function renderContactsList(c){const el=document.getElementById('contactsList');if(!c.length){el.innerHTML='<div style="padding:24px;text-align:center;color:#a0aec0;font-size:14px">Ingen kontakter ennå</div>';return;}el.innerHTML=c.map(x=>'<div class="contact-item" onclick="selectContact(\''+x.number+'\')"><div><div class="contact-number">'+x.number+'</div><div class="contact-meta">'+x.messageCount+' meldinger · '+timeAgo(x.lastSeen)+'</div></div><span style="color:#a0aec0">→</span></div>').join('');}
function selectContact(n){document.getElementById('sendTo').value=n;hideContacts();document.getElementById('sendBody').focus();}
function filterContacts(v){renderDropdown(v?allContacts.filter(c=>c.number.includes(v)):allContacts);}
function renderDropdown(c){const dd=document.getElementById('contactDropdown');if(!c.length){dd.classList.add('hidden');return;}dd.classList.remove('hidden');dd.innerHTML=c.slice(0,8).map(x=>'<div class="contact-item" onmousedown="selectContact(\''+x.number+'\')"><div><div class="contact-number">'+x.number+'</div><div class="contact-meta">'+timeAgo(x.lastSeen)+'</div></div></div>').join('');}
function showContacts(){if(allContacts.length)renderDropdown(allContacts);}
function hideContacts(){document.getElementById('contactDropdown').classList.add('hidden');}
function updateCharCount(){const len=document.getElementById('sendBody').value.length;document.getElementById('charCount').textContent=len===0?'0 tegn':len<=160?len+' tegn':len+' tegn ('+Math.ceil(len/160)+' SMS-deler)';}
async function sendSms(){const to=document.getElementById('sendTo').value.trim(),body=document.getElementById('sendBody').value.trim(),st=document.getElementById('sendStatus'),btn=document.getElementById('sendBtn');if(!to){toast('Skriv inn mottaker',false);return;}if(!body){toast('Skriv inn melding',false);return;}btn.disabled=true;btn.innerHTML='<span>⏳</span> Sender...';const res=await api('/api/sms/send',{method:'POST',body:JSON.stringify({to,body})});btn.disabled=false;btn.innerHTML='<span>📤</span> Send SMS';if(res.success){st.className='send-status success';st.textContent='✅ Lagt i kø! Gateway-telefonen sender snart.';st.classList.remove('hidden');document.getElementById('sendTo').value='';document.getElementById('sendBody').value='';updateCharCount();loadContactsList();setTimeout(()=>st.classList.add('hidden'),4000);toast('Sendt!');}else{st.className='send-status error';st.textContent='❌ '+(res.error||'Feil');st.classList.remove('hidden');}}
async function loadInbox(){const search=document.getElementById('inboxSearch')?.value||'';const data=await api('/api/sms/inbox?limit=100&search='+encodeURIComponent(search));document.getElementById('inboxTable').innerHTML=data.length?data.map(m=>'<tr><td><strong>'+m.from+'</strong></td><td style="max-width:400px;word-break:break-word;line-height:1.5">'+m.body+'</td><td style="white-space:nowrap;color:#a0aec0;font-size:13px">'+timeAgo(m.receivedAt)+'</td><td><button class="btn btn-outline btn-sm" onclick="selectAndSwitch(\''+m.from+'\')">Svar</button></td></tr>').join(''):'<tr><td colspan="4" style="text-align:center;color:#a0aec0;padding:40px">Ingen innkommende meldinger</td></tr>';document.getElementById('inboxExport').onclick=()=>{window.location.href=BASE+'/kunde/'+SLUG+'/api/export/inbox?token='+token;};}
function selectAndSwitch(num){document.getElementById('sendTo').value=num;switchTab('send',document.querySelector('nav button:nth-child(2)'));}
async function loadSent(){const search=document.getElementById('sentSearch')?.value||'';const data=await api('/api/sms/sent?limit=100&search='+encodeURIComponent(search));document.getElementById('sentTable').innerHTML=data.length?data.map(m=>'<tr><td><strong>'+m.to+'</strong></td><td style="max-width:400px;word-break:break-word;line-height:1.5">'+(m.body||'')+'</td><td><span class="badge badge-green">✓ Sendt</span></td><td style="white-space:nowrap;color:#a0aec0;font-size:13px">'+timeAgo(m.sentAt||m.createdAt)+'</td></tr>').join(''):'<tr><td colspan="4" style="text-align:center;color:#a0aec0;padding:40px">Ingen sendte meldinger</td></tr>';document.getElementById('sentExport').onclick=()=>{window.location.href=BASE+'/kunde/'+SLUG+'/api/export/sent?token='+token;};}
async function loadWebhooks(){const data=await api('/api/webhooks');document.getElementById('webhooksTable').innerHTML=data.length?data.map(w=>'<tr><td style="word-break:break-all;font-size:13px">'+w.url+'</td><td style="font-size:13px">'+(w.events||[]).join(', ')+'</td><td><span class="badge badge-green">Aktiv</span></td><td><button class="btn btn-danger btn-sm" onclick="deleteWebhook(\''+w.id+'\')">Slett</button></td></tr>').join(''):'<tr><td colspan="4" style="text-align:center;color:#a0aec0;padding:32px">Ingen webhooks</td></tr>';}
async function addWebhook(){const url=document.getElementById('webhookUrl').value.trim(),secret=document.getElementById('webhookSecret').value.trim(),events=[...document.querySelectorAll('#tab-webhooks input[type=checkbox]:checked')].map(c=>c.value);if(!url){toast('Skriv inn URL',false);return;}await api('/api/webhooks',{method:'POST',body:JSON.stringify({url,secret,events})});document.getElementById('webhookUrl').value='';loadWebhooks();toast('Webhook lagt til!');}
async function deleteWebhook(id){await api('/api/webhooks/'+id,{method:'DELETE'});loadWebhooks();toast('Webhook slettet');}
async function loadRules(){const data=await api('/api/rules');document.getElementById('rulesTable').innerHTML=data.length?data.map(r=>'<tr><td><strong>'+r.name+'</strong></td><td><code style="background:#f7fafc;padding:2px 6px;border-radius:4px;font-size:12px">'+r.trigger+'</code></td><td style="max-width:200px;word-break:break-word;font-size:13px">'+r.response+'</td><td><label class="switch"><input type="checkbox" '+(r.enabled?'checked':'')+' onchange="toggleRule(\''+r.id+'\',this.checked)"><span class="slider"></span></label></td><td><button class="btn btn-danger btn-sm" onclick="deleteRule(\''+r.id+'\')">Slett</button></td></tr>').join(''):'<tr><td colspan="5" style="text-align:center;color:#a0aec0;padding:32px">Ingen regler</td></tr>';}
async function addRule(){const name=document.getElementById('ruleName').value.trim(),trigger=document.getElementById('ruleTrigger').value.trim(),response=document.getElementById('ruleResponse').value.trim(),isRegex=document.getElementById('ruleIsRegex').checked;if(!name||!trigger||!response){toast('Fyll inn alle felter',false);return;}await api('/api/rules',{method:'POST',body:JSON.stringify({name,trigger,response,isRegex})});document.getElementById('ruleName').value='';document.getElementById('ruleTrigger').value='';document.getElementById('ruleResponse').value='';loadRules();toast('Regel lagt til!');}
async function toggleRule(id,enabled){await api('/api/rules/'+id,{method:'PUT',body:JSON.stringify({enabled})});}
async function deleteRule(id){await api('/api/rules/'+id,{method:'DELETE'});loadRules();toast('Regel slettet');}
async function changePassword(){const cur=document.getElementById('curPwd').value,nw=document.getElementById('newPwdField').value,cf=document.getElementById('cfmPwd').value,st=document.getElementById('pwdStatus');if(nw!==cf){st.innerHTML='<span style="color:#e53e3e">Passordene er ikke like</span>';return;}const res=await api('/auth/change-password',{method:'POST',body:JSON.stringify({currentPassword:cur,newPassword:nw})});if(res.success){st.innerHTML='<span style="color:#276749">✅ Passord endret!</span>';toast('Passord endret!');}else{st.innerHTML='<span style="color:#e53e3e">❌ '+(res.error||'Feil')+'</span>';}}
function init(){loadStats();loadContactsList();setInterval(()=>{loadStats();},5000);}
async function checkSession(){if(!token)return;const res=await api('/api/stats').catch(()=>null);if(res&&!res.error){document.getElementById('loginOverlay').style.display='none';document.getElementById('app').classList.remove('hidden');init();}else{localStorage.removeItem('sms_token_'+SLUG);token='';}}
checkSession();
document.getElementById('loginPwd').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script></body></html>`;
}

// ── START ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
    app.listen(PORT, () => {
        console.log('SMS Gateway Server v4.0 med PostgreSQL');
        console.log('Admin: http://localhost:' + PORT + '/admin');
    });
}).catch(err => {
    console.error('Database feil:', err);
    process.exit(1);
});
