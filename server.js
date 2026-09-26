const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync, backup } = require('node:sqlite');
const { createClient } = require('@supabase/supabase-js');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || ADMIN_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY);
const IS_VERCEL = Boolean(process.env.VERCEL);
const USE_SQLITE = !IS_VERCEL && !USE_SUPABASE;
const DATABASE_CONFIGURED = USE_SUPABASE || USE_SQLITE;
const loginAttempts = new Map();
const submissionAttempts = new Map();
const PRIVACY_VERSION = '2026-09';
const RULES_VERSION = '2026-09';
const RETENTION_DAYS = 60;
const SERVICE_CHOICES = new Set([
  'Avaliação — R$ 10,00',
  'Vídeo personalizado',
  'Videochamada — R$ 99,00 / 10 min'
]);
const PRIVACY_CHOICES = new Set([
  'Privacidade — Acesso aos dados',
  'Privacidade — Correção de dados',
  'Privacidade — Exclusão de dados'
]);

// Pode publicar na Vercel antes de configurar Supabase/admin.
// Rotas dependentes retornam 503 enquanto a configuração não existir.

let db;
let insertRequest;
let listRequests;
let updateStatus;
let updateNotes;
let deleteRequest;
let findDuplicate;
let purgeOldRequests;
const supabase = USE_SUPABASE ? createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
}) : null;

if (USE_SQLITE) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(path.join(DATA_DIR, 'projeto-m.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_type TEXT NOT NULL CHECK(contact_type IN ('telefone', 'instagram', 'telegram')),
      contact_value TEXT NOT NULL,
      choice TEXT NOT NULL,
      custom_details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'novo' CHECK(status IN ('novo', 'em_contato', 'concluido')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(requests)').all().map(column => column.name));
  if (!columns.has('consent_at')) db.exec('ALTER TABLE requests ADD COLUMN consent_at TEXT');
  if (!columns.has('privacy_version')) db.exec("ALTER TABLE requests ADD COLUMN privacy_version TEXT NOT NULL DEFAULT '2026-09'");
  if (!columns.has('admin_notes')) db.exec("ALTER TABLE requests ADD COLUMN admin_notes TEXT NOT NULL DEFAULT ''");
  if (!columns.has('updated_at')) db.exec('ALTER TABLE requests ADD COLUMN updated_at TEXT');
  if (!columns.has('workflow_status')) {
    db.exec("ALTER TABLE requests ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'novo'");
    db.exec("UPDATE requests SET workflow_status = CASE WHEN status = 'em_contato' THEN 'contato_iniciado' ELSE status END");
  }
  if (!columns.has('rules_accepted_at')) db.exec('ALTER TABLE requests ADD COLUMN rules_accepted_at TEXT');
  if (!columns.has('rules_version')) db.exec('ALTER TABLE requests ADD COLUMN rules_version TEXT');
  insertRequest = db.prepare("INSERT INTO requests (name, contact_type, contact_value, choice, custom_details, consent_at, privacy_version, rules_accepted_at, rules_version, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?, datetime('now'))");
  listRequests = db.prepare('SELECT id, name, contact_type, contact_value, choice, custom_details, workflow_status AS status, consent_at, privacy_version, rules_accepted_at, rules_version, admin_notes, created_at, updated_at FROM requests ORDER BY id DESC LIMIT 500');
  updateStatus = db.prepare("UPDATE requests SET workflow_status = ?, updated_at = datetime('now') WHERE id = ?");
  updateNotes = db.prepare("UPDATE requests SET admin_notes = ?, updated_at = datetime('now') WHERE id = ?");
  deleteRequest = db.prepare('DELETE FROM requests WHERE id = ?');
  findDuplicate = db.prepare("SELECT id FROM requests WHERE contact_type = ? AND lower(contact_value) = lower(?) AND choice = ? AND created_at >= datetime('now', '-5 minutes') LIMIT 1");
  purgeOldRequests = db.prepare(`DELETE FROM requests WHERE workflow_status IN ('concluido', 'recusado') AND datetime(COALESCE(updated_at, created_at)) < datetime('now', '-${RETENTION_DAYS} days')`);
}

function ensureDatabaseConfigured() {
  if (!DATABASE_CONFIGURED) {
    const error = new Error('Banco de dados ainda não configurado.');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
}

function throwDatabaseError(error) {
  if (!error) return;
  console.error('Supabase database error:', {
    message: error.message,
    code: error.code,
    details: error.details,
    hint: error.hint,
    status: error.status
  });
  const wrapped = new Error('Falha ao acessar o banco de dados.');
  wrapped.code = 'SUPABASE_DATABASE_ERROR';
  wrapped.databaseError = {
    message: error.message || 'Erro desconhecido',
    code: error.code || null,
    details: error.details || null,
    hint: error.hint || null,
    status: error.status || null
  };
  throw wrapped;
}

async function findStoredDuplicate(contactType, contactValue, choice) {
  ensureDatabaseConfigured();
  if (USE_SQLITE) return findDuplicate.get(contactType, contactValue, choice);
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('requests').select('id').eq('contact_type', contactType).ilike('contact_value', contactValue).eq('choice', choice).gte('created_at', since).limit(1).maybeSingle();
  throwDatabaseError(error);
  return data;
}

async function insertStoredRequest(record) {
  ensureDatabaseConfigured();
  if (USE_SQLITE) {
    const result = insertRequest.run(record.name, record.contact_type, record.contact_value, record.choice, record.custom_details, record.privacy_version, record.rules_accepted_at ? 1 : 0, record.rules_version);
    return Number(result.lastInsertRowid);
  }
  const { data, error } = await supabase.from('requests').insert(record).select('id').single();
  throwDatabaseError(error);
  return Number(data.id);
}

async function listStoredRequests() {
  ensureDatabaseConfigured();
  if (USE_SQLITE) return listRequests.all();
  const { data, error } = await supabase.from('requests').select('id,name,contact_type,contact_value,choice,custom_details,workflow_status,consent_at,privacy_version,rules_accepted_at,rules_version,admin_notes,created_at,updated_at').order('id', { ascending: false }).limit(500);
  throwDatabaseError(error);
  return data.map(item => ({ ...item, status: item.workflow_status }));
}

async function updateStoredStatus(id, status) {
  ensureDatabaseConfigured();
  if (USE_SQLITE) return updateStatus.run(status, id);
  const { error } = await supabase.from('requests').update({ workflow_status: status, updated_at: new Date().toISOString() }).eq('id', id);
  throwDatabaseError(error);
}

async function updateStoredNotes(id, notes) {
  ensureDatabaseConfigured();
  if (USE_SQLITE) return updateNotes.run(notes, id);
  const { error } = await supabase.from('requests').update({ admin_notes: notes, updated_at: new Date().toISOString() }).eq('id', id);
  throwDatabaseError(error);
}

async function deleteStoredRequest(id) {
  ensureDatabaseConfigured();
  if (USE_SQLITE) return deleteRequest.run(id);
  const { error } = await supabase.from('requests').delete().eq('id', id);
  throwDatabaseError(error);
}

async function purgeStoredRequests() {
  if (!DATABASE_CONFIGURED) return 0;
  if (USE_SQLITE) return purgeOldRequests.run().changes;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const { data, error } = await supabase.from('requests').delete().in('workflow_status', ['concluido', 'recusado']).lt('updated_at', cutoff).select('id');
  throwDatabaseError(error);
  return data.length;
}

async function purgeExpiredRequests() {
  const changes = await purgeStoredRequests();
  if (changes) console.log(`${changes} solicitacao(oes) antiga(s) removida(s) pela politica de retencao.`);
}

const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (USE_SQLITE) fs.mkdirSync(BACKUP_DIR, { recursive: true });
async function createDailyBackup() {
  if (!USE_SQLITE) return;
  const day = new Date().toISOString().slice(0, 10);
  const destination = path.join(BACKUP_DIR, `projeto-m-${day}.sqlite`);
  if (!fs.existsSync(destination)) await backup(db, destination);
  const files = fs.readdirSync(BACKUP_DIR).filter(name => /^projeto-m-\d{4}-\d{2}-\d{2}\.sqlite$/.test(name)).sort().reverse();
  for (const oldFile of files.slice(7)) fs.rmSync(path.join(BACKUP_DIR, oldFile));
}

if (require.main === module) {
  purgeExpiredRequests().catch(error => console.error('Falha ao aplicar retencao:', error.message));
  createDailyBackup().catch(error => console.error('Falha ao criar backup:', error.message));
  setInterval(() => purgeExpiredRequests().catch(error => console.error('Falha ao aplicar retencao:', error.message)), 6 * 60 * 60 * 1000).unref();
  setInterval(() => createDailyBackup().catch(error => console.error('Falha ao criar backup:', error.message)), 24 * 60 * 60 * 1000).unref();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, attempt] of loginAttempts) if (!attempt.blockedUntil || attempt.blockedUntil < now) loginAttempts.delete(ip);
    for (const [ip, attempts] of submissionAttempts) {
      const recent = attempts.filter(time => time > now - 10 * 60 * 1000);
      if (recent.length) submissionAttempts.set(ip, recent);
      else submissionAttempts.delete(ip);
    }
  }, 15 * 60 * 1000).unref();
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4'
};

function send(res, status, body, contentType = 'application/json; charset=utf-8', headers = {}) {
  res.writeHead(status, { 'Content-Type': contentType, 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') {
    try { return Promise.resolve(JSON.parse(req.body || '{}')); } catch { return Promise.reject(new Error('Dados invalidos.')); }
  }
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 100000) {
        reject(new Error('Dados muito grandes.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Dados invalidos.')); }
    });
    req.on('error', reject);
  });
}

function getCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(item => {
    const index = item.indexOf('=');
    return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1))];
  }));
}

function signSession(expires) {
  const payload = String(expires);
  const signature = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function isAdmin(req) {
  const token = getCookies(req).admin_session || '';
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !/^\d+$/.test(payload) || Number(payload) < Date.now()) return false;
  const expected = crypto.createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('base64url');
  return sameSecret(signature, expected);
}

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function sameSecret(value, expected) {
  const supplied = Buffer.from(value);
  const target = Buffer.from(expected);
  return supplied.length === target.length && crypto.timingSafeEqual(supplied, target);
}

async function api(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    const base = {
      ok: true,
      database: USE_SUPABASE ? 'supabase' : (USE_SQLITE ? 'sqlite' : 'not_configured'),
      databaseConfigured: DATABASE_CONFIGURED,
      adminConfigured: Boolean(ADMIN_PASSWORD && ADMIN_SESSION_SECRET.length >= 32),
      time: new Date().toISOString()
    };
    if (USE_SUPABASE) {
      try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/requests?select=id&limit=1`, {
          headers: {
            apikey: SUPABASE_SECRET_KEY,
            Accept: 'application/json'
          }
        });
        const rawText = await response.text();
        let rawBody = rawText;
        try { rawBody = JSON.parse(rawText); } catch {}
        if (!response.ok) {
          console.error('Supabase raw health check failed:', { status: response.status, body: rawBody });
          return send(res, 503, {
            ...base,
            ok: false,
            databaseReachable: false,
            databaseError: {
              message: (rawBody && typeof rawBody === 'object' && (rawBody.message || rawBody.error)) || 'Supabase recusou a requisicao.',
              code: (rawBody && typeof rawBody === 'object' && rawBody.code) || null,
              hint: (rawBody && typeof rawBody === 'object' && rawBody.hint) || null,
              status: response.status
            }
          });
        }
        base.databaseReachable = true;
        base.databaseHttpStatus = response.status;
      } catch (error) {
        console.error('Supabase raw health check network failure:', error);
        return send(res, 503, {
          ...base,
          ok: false,
          databaseReachable: false,
          databaseError: {
            message: error && error.message ? error.message : 'Falha de rede ao acessar o Supabase.',
            code: null,
            hint: null,
            status: null
          }
        });
      }
    }
    return send(res, 200, base);
  }
  if (req.method === 'POST' && url.pathname === '/api/requests') {
    try {
      const ip = clean(req.socket.remoteAddress || 'local', 100);
      const now = Date.now();
      const attempts = (submissionAttempts.get(ip) || []).filter(time => time > now - 10 * 60 * 1000);
      if (attempts.length >= 8) return send(res, 429, { error: 'Muitas solicitacoes. Aguarde alguns minutos.' });
      const data = await readJson(req);
      const name = clean(data.name, 80);
      const contactType = clean(data.contactType, 20);
      const contactValue = clean(data.contactValue, 120);
      const choice = clean(data.choice, 120);
      const consent = data.consent === true || data.consent === 'true' || data.consent === 'on';
      const rulesConsent = data.rulesConsent === true || data.rulesConsent === 'true' || data.rulesConsent === 'on';
      const privacyRequest = PRIVACY_CHOICES.has(choice);
      const customDetails = privacyRequest ? clean(data.customDetails, 500) : '';
      if (!SERVICE_CHOICES.has(choice) && !privacyRequest) {
        return send(res, 400, { error: 'Servico invalido.' });
      }
      if (!name || !contactValue || !choice || !consent || (!privacyRequest && !rulesConsent) || contactType !== 'telegram') {
        return send(res, 400, { error: 'Preencha todos os campos obrigatorios.' });
      }
      const telegramUser = /^@[A-Za-z0-9_]{5,32}$/.test(contactValue);
      const telegramDigits = contactValue.replace(/\D/g, '');
      const telegramPhone = /^\+?[0-9 ()-]+$/.test(contactValue) && telegramDigits.length >= 10 && telegramDigits.length <= 15;
      if (!telegramUser && !telegramPhone) {
        return send(res, 400, { error: 'Informe o @usuario ou o numero do Telegram com DDD.' });
      }
      const duplicate = await findStoredDuplicate(contactType, contactValue, choice);
      if (duplicate) return send(res, 409, { error: 'Esta solicitacao ja foi recebida.', id: duplicate.id });
      const nowIso = new Date().toISOString();
      const id = await insertStoredRequest({
        name,
        contact_type: contactType,
        contact_value: contactValue,
        choice,
        custom_details: customDetails,
        workflow_status: 'novo',
        consent_at: nowIso,
        privacy_version: PRIVACY_VERSION,
        rules_accepted_at: rulesConsent ? nowIso : null,
        rules_version: rulesConsent ? RULES_VERSION : null,
        admin_notes: '',
        updated_at: nowIso
      });
      attempts.push(now);
      submissionAttempts.set(ip, attempts);
      return send(res, 201, { ok: true, id, protocol: `PM-${String(id).padStart(6, '0')}` });
    } catch (error) {
      return send(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    if (!ADMIN_PASSWORD || ADMIN_SESSION_SECRET.length < 32) return send(res, 503, { error: 'Painel administrativo ainda não configurado.' });
    const ip = clean(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'local', 100).split(',')[0];
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.blockedUntil > Date.now()) {
      return send(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
    }
    const data = await readJson(req).catch(() => ({}));
    if (!sameSecret(clean(data.user), ADMIN_USER) || !sameSecret(clean(data.password), ADMIN_PASSWORD)) {
      const failures = (attempt?.failures || 0) + 1;
      loginAttempts.set(ip, { failures, blockedUntil: failures >= 5 ? Date.now() + 15 * 60 * 1000 : 0 });
      return send(res, 401, { error: 'Usuario ou senha invalidos.' });
    }
    loginAttempts.delete(ip);
    const token = signSession(Date.now() + 8 * 60 * 60 * 1000);
    const secureCookie = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, undefined, {
      'Set-Cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const secureCookie = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, undefined, {
      'Set-Cookie': `admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`
    });
  }

  if (url.pathname.startsWith('/api/admin/') && !isAdmin(req)) {
    return send(res, 401, { error: 'Nao autorizado.' });
  }
  if (req.method === 'GET' && url.pathname === '/api/admin/requests') {
    await purgeExpiredRequests();
    return send(res, 200, { requests: await listStoredRequests() });
  }
  const statusMatch = url.pathname.match(/^\/api\/admin\/requests\/(\d+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    const data = await readJson(req).catch(() => ({}));
    if (!['novo', 'contato_iniciado', 'aguardando_pagamento', 'confirmado', 'concluido', 'recusado'].includes(data.status)) {
      return send(res, 400, { error: 'Status invalido.' });
    }
    await updateStoredStatus(Number(statusMatch[1]), data.status);
    return send(res, 200, { ok: true });
  }
  const notesMatch = url.pathname.match(/^\/api\/admin\/requests\/(\d+)\/notes$/);
  if (req.method === 'PATCH' && notesMatch) {
    const data = await readJson(req).catch(() => ({}));
    await updateStoredNotes(Number(notesMatch[1]), clean(data.notes, 1000));
    return send(res, 200, { ok: true });
  }
  const deleteMatch = url.pathname.match(/^\/api\/admin\/requests\/(\d+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    await deleteStoredRequest(Number(deleteMatch[1]));
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Rota nao encontrada.' });
}

function serveStatic(res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  let publicPath;
  try {
    publicPath = decodeURIComponent(requested);
  } catch {
    return send(res, 400, 'Endereco invalido', 'text/plain; charset=utf-8');
  }
  if (publicPath !== '/index.html' && !publicPath.startsWith('/assets/')) {
    return send(res, 403, 'Acesso negado', 'text/plain; charset=utf-8');
  }
  const assetsRoot = path.join(ROOT, 'assets');
  const filePath = publicPath === '/index.html'
    ? path.join(ROOT, 'index.html')
    : path.resolve(assetsRoot, publicPath.slice('/assets/'.length));
  if (publicPath !== '/index.html' && filePath !== assetsRoot && !filePath.startsWith(assetsRoot + path.sep)) {
    return send(res, 403, 'Acesso negado', 'text/plain; charset=utf-8');
  }
  fs.readFile(filePath, (error, data) => {
    if (error) return send(res, 404, 'Pagina nao encontrada', 'text/plain; charset=utf-8');
    send(res, 200, data, mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
  });
}

function setSecurityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

async function handleApiRoute(req, res, pathname) {
  setSecurityHeaders(req, res);
  const base = `http://${req.headers.host || 'localhost'}`;
  const incoming = new URL(req.url || '/', base);
  const url = new URL(pathname, base);
  url.search = incoming.search;
  try {
    return await api(req, res, url);
  } catch (error) {
    console.error('Falha na API:', error.message);
    if (!res.headersSent) {
      if (error.code === 'DATABASE_NOT_CONFIGURED') return send(res, 503, { error: 'Banco de dados ainda não configurado.' });
      return send(res, 500, { error: 'Não foi possível concluir a operação.' });
    }
  }
}

async function handleApiRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  return handleApiRoute(req, res, url.pathname);
}

async function handleLocalRequest(req, res) {
  setSecurityHeaders(req, res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApiRequest(req, res);
  serveStatic(res, url);
}

if (require.main === module) {
  http.createServer(handleLocalRequest).listen(PORT, () => {
    console.log(`Bruno e Renata disponivel em http://localhost:${PORT} (${USE_SUPABASE ? 'Supabase' : (USE_SQLITE ? 'SQLite local' : 'sem banco')})`);
    if (ADMIN_PASSWORD.length < 12) console.warn('ATENCAO: use uma senha administrativa com pelo menos 12 caracteres antes de publicar.');
  });
}

// Vercel pode detectar server.js como entrypoint principal.
module.exports = handleLocalRequest;
module.exports.handleApiRequest = handleApiRequest;
module.exports.handleApiRoute = handleApiRoute;
module.exports.handleLocalRequest = handleLocalRequest;
