'use strict';
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'db.json');

// ─── Redirect www → non-www (301) ────────────────────────────────────────────
app.use((req, res, next) => {
  const host = req.headers.host || '';
  if (host.startsWith('www.')) {
    const target = `https://${host.slice(4)}${req.originalUrl}`;
    return res.redirect(301, target);
  }
  next();
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());

// Bloquear archivos sensibles del repo: aunque estén en el root, no deben servirse.
// Lista negra por archivo (NO por extensión) porque manifest-core.js sí es público.
// Cubre: base de datos con credenciales, código del server, config, deploy y docs.
// IMPORTANTE: req.path NO viene decodificado, pero express.static sí decodifica y
// resuelve ./ y ../ antes de servir. Por eso decodificamos y normalizamos el path
// ANTES de comparar; si no, /db%2Ejson o /./db.json saltarían la lista negra.
const BLOCKED_PATHS = /^\/(?:db\.json|server\.js|package(?:-lock)?\.json|deploy\.sh|\.env|[^/]*\.md|[^/]*\.backup|docs\/)/i;
app.use((req, res, next) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch { return res.status(400).send('Bad request'); }
  p = path.posix.normalize(p.replace(/\\/g, '/'));   // colapsa ./ y ../, unifica separadores
  if (BLOCKED_PATHS.test(p)) return res.status(404).send('Not found');
  next();
});

// Static files con Cache-Control diferenciado por tipo
app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    // Imágenes, video, fuentes — 1 año (son assets con nombre fijo o versionados)
    if (['.jpg','.jpeg','.png','.webp','.gif','.svg','.mp4','.webm','.woff','.woff2','.ttf'].includes(ext)) {
      res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // JS y CSS — 1 semana (pueden cambiar con deploys)
    } else if (['.js','.css'].includes(ext)) {
      res.set('Cache-Control', 'public, max-age=604800, must-revalidate');
    // HTML — siempre revalidar
    } else if (ext === '.html' || ext === '') {
      res.set('Cache-Control', 'no-cache');
    // XML, txt (sitemap, robots) — 1 día
    } else if (['.xml','.txt'].includes(ext)) {
      res.set('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// El webhook de 17track necesita el raw body para verificar la firma
app.use('/api/webhook/17track', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// ─── Crear directorio de documentos si no existe ────────────────────────────────
const DOCS_DIR = path.join(__dirname, 'documents');
if (!fs.existsSync(DOCS_DIR)) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
}

// ─── Headers de Seguridad ────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.set('X-Frame-Options', 'DENY');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-XSS-Protection', '1; mode=block');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── Log de todas las peticiones POST/PUT/DELETE ─────────────────────────────
app.use((req, res, next) => {
  if (['POST','PUT','DELETE'].includes(req.method) && req.path.startsWith('/api')) {
    console.log(`[req] ${req.method} ${req.path} — body keys: ${Object.keys(req.body || {}).join(',') || 'EMPTY'}`);
  }
  next();
});

const SUPERADMINS = [
  {
    email: process.env.ADMIN_1_EMAIL,
    username: process.env.ADMIN_1_USERNAME,
    password: process.env.ADMIN_1_PASSWORD,
    name: process.env.ADMIN_1_NAME
  },
  {
    email: process.env.ADMIN_2_EMAIL,
    username: process.env.ADMIN_2_USERNAME,
    password: process.env.ADMIN_2_PASSWORD,
    name: process.env.ADMIN_2_NAME
  }
  // Descartar slots de admin sin configurar: si un ADMIN_N_* no está en el .env,
  // sus campos quedan undefined y romperían el login (undefined.toLowerCase()).
].filter(s => (s.email || s.username) && s.password);
if (SUPERADMINS.length === 0) console.warn('⚠ Ningún SUPERADMIN configurado (revisá ADMIN_1_* en .env)');

// ─── Token de admin ESTABLE entre reinicios ───────────────────────────────────
// Antes era aleatorio por proceso (crypto.randomBytes), así que cada vez que el
// hosting reiniciaba la app por inactividad (Passenger) o en cada redeploy, el
// token cambiaba y el admin quedaba deslogueado a mitad de trabajo. Ahora se
// deriva de un secreto estable → sobrevive reinicios y redeploys. Solo cambia si
// cambian las credenciales de admin (o si se define ADMIN_TOKEN_SECRET en .env).
const ADMIN_TOKEN_SEED = process.env.ADMIN_TOKEN_SECRET
  || SUPERADMINS.map(s => `${s.username || ''}:${s.email || ''}:${s.password || ''}`).join('|')
  || 'arbox-fallback-seed';
const ADMIN_TOKEN = crypto.createHash('sha256').update('arbox-admin-v1|' + ADMIN_TOKEN_SEED).digest('hex');

// ─── Base de datos (archivo JSON) ────────────────────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = {
      clients: [],
      packages: [],
      movements: [],
      documents: {}
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.documents) db.documents = {};
  return db;
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    return res.status(403).json({ error: 'Acceso denegado' });
  }
  next();
}

function saveDB(data, operation = 'unknown') {
  console.log(`[db] ${operation} — ${data.clients.length} clients, ${data.packages.length} packages, ${data.movements.length} movements`);
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function addHistorialEntry(pkg, newEstado) {
  if (!pkg.historial) pkg.historial = [];
  pkg.historial.push({ estado: newEstado, fecha: new Date().toISOString().split('T')[0], ts: Date.now() });
}

function applyETA(pkg, newEstado) {
  if (newEstado === 'En tránsito' && pkg.estado !== 'En tránsito') {
    const d = new Date();
    d.setDate(d.getDate() + 5);
    pkg.fechaEstimadaEntrega = d.toISOString().split('T')[0];
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST   || 'smtp.gmail.com',
  port:   Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendArrivalEmail(client, pkg, eventDescription) {
  const deposito = pkg.deposito;
  const flag = { Miami: '🇺🇸', Madrid: '🇪🇸', China: '🇨🇳' }[deposito] || '';

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
    <!-- Header -->
    <div style="background:#0a0a0a;padding:28px 32px">
      <div style="color:#fff;font-size:1.2rem;font-weight:800;letter-spacing:-.02em">Arbox Argentina</div>
      <div style="color:rgba(255,255,255,.5);font-size:.82rem;margin-top:4px">Notificación automática de paquete</div>
    </div>
    <!-- Body -->
    <div style="padding:32px">
      <p style="color:#555;font-size:.95rem;margin-bottom:20px">Hola <strong style="color:#0a0a0a">${client.name}</strong>,</p>
      <div style="background:#f5f5f5;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:.75rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px">Paquete recibido en depósito ${flag}</div>
        <div style="font-size:1.5rem;font-weight:800;color:#0a0a0a;letter-spacing:-.03em">${deposito}</div>
        <div style="color:#555;font-size:.9rem;margin-top:8px">${pkg.desc}</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:.88rem;margin-bottom:24px">
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#888">Tracking</td>
          <td style="padding:10px 0;color:#0a0a0a;font-weight:700;text-align:right">${pkg.id}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#888">Peso</td>
          <td style="padding:10px 0;color:#0a0a0a;font-weight:700;text-align:right">${pkg.peso} kg</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#888">Costo estimado</td>
          <td style="padding:10px 0;color:#0a0a0a;font-weight:700;text-align:right">USD ${pkg.costo.toFixed(2)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#888">Último evento</td>
          <td style="padding:10px 0;color:#0a0a0a;font-size:.82rem;text-align:right;max-width:220px">${eventDescription}</td>
        </tr>
      </table>
      <p style="color:#555;font-size:.88rem;line-height:1.7;margin-bottom:28px">
        Tu paquete llegó a nuestro depósito y está siendo procesado. En breve te informaremos cuando sea despachado hacia Argentina.
      </p>
      <div style="text-align:center">
        <a href="${process.env.PUBLIC_URL || 'http://localhost:' + PORT}"
           style="background:#0a0a0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;display:inline-block">
          Ver mi Panel
        </a>
      </div>
    </div>
    <!-- Footer -->
    <div style="background:#f5f5f5;padding:18px 32px;border-top:1px solid #eee">
      <p style="color:#aaa;font-size:.75rem;margin:0;text-align:center">
        Arbox Argentina — 10 años de trayectoria en Comercio Exterior<br>
        Este es un mensaje automático, no respondas a este email.
      </p>
    </div>
  </div>
</body>
</html>`;

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || 'Arbox Argentina <noreply@arboxargentina.com>',
    to:      client.email,
    subject: `${flag} Tu paquete llegó al depósito de ${deposito} — ${pkg.id}`,
    html,
  });

  console.log(`[email] Notificación enviada a ${client.email} — paquete ${pkg.id} en ${deposito}`);
}

async function sendStatusChangeEmail(client, pkg, oldStatus, newStatus) {
  const deposito = pkg.deposito;
  const flag = { Miami: '🇺🇸', Madrid: '🇪🇸', China: '🇨🇳' }[deposito] || '';

  const statusMessages = {
    'Registrado': 'Tu paquete ha sido registrado en nuestro sistema.',
    'Recibido en origen': 'Tu paquete fue recibido en el depósito de origen.',
    'En depósito': 'Tu paquete está en nuestro depósito aguardando despacho.',
    'En tránsito': 'Tu paquete se encuentra en tránsito hacia Argentina.',
    'En viaje': 'Tu paquete está en viaje hacia su destino.',
    'Clasificando en BsAs': 'Tu paquete está siendo clasificado en Buenos Aires.',
    'Listo para entrega': 'Tu paquete está listo para ser entregado.',
    'Entregado': '¡Tu paquete ha sido entregado!',
    'Retenido': 'Tu paquete ha sido retenido. Contactanos para más información.'
  };

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',sans-serif">
  <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0a0a0a;padding:28px 32px">
      <div style="color:#fff;font-size:1.2rem;font-weight:800;letter-spacing:-.02em">Arbox Argentina</div>
      <div style="color:rgba(255,255,255,.5);font-size:.82rem;margin-top:4px">Actualización de estado del paquete</div>
    </div>
    <div style="padding:32px">
      <p style="color:#555;font-size:.95rem;margin-bottom:20px">Hola <strong style="color:#0a0a0a">${client.name}</strong>,</p>
      <div style="background:#f5f5f5;border-radius:10px;padding:20px;margin-bottom:24px">
        <div style="font-size:.75rem;font-weight:700;color:#888;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Nuevo estado</div>
        <div style="font-size:1.3rem;font-weight:800;color:#0a0a0a;letter-spacing:-.03em">${newStatus}</div>
        <div style="color:#666;font-size:.85rem;margin-top:12px">${statusMessages[newStatus] || 'Tu paquete ha cambiado de estado.'}</div>
      </div>
      ${(newStatus === 'En tránsito' && pkg.fechaArriboBsAs) ? `
      <div style="background:#eef5ff;border-radius:10px;padding:16px 20px;margin-bottom:24px">
        <div style="font-size:.75rem;font-weight:700;color:#1565c0;text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px">Fechas estimadas</div>
        <div style="color:#0a0a0a;font-size:.9rem">🛬 Arribo a Buenos Aires: <strong>${pkg.fechaArriboBsAs}</strong></div>
        ${pkg.fechaEstimadaEntrega ? `<div style="color:#0a0a0a;font-size:.9rem;margin-top:4px">📦 Entrega estimada: <strong>${pkg.fechaEstimadaEntrega}</strong></div>` : ''}
        <div style="color:#888;font-size:.78rem;margin-top:8px">Son fechas estimadas y pueden variar.</div>
      </div>` : ''}
      <table style="width:100%;border-collapse:collapse;font-size:.88rem;margin-bottom:24px">
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#888">Tracking</td>
          <td style="padding:10px 0;color:#0a0a0a;font-weight:700;text-align:right">${pkg.id}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#888">Descripción</td>
          <td style="padding:10px 0;color:#0a0a0a;text-align:right">${pkg.desc}</td>
        </tr>
        <tr style="border-bottom:1px solid #eee">
          <td style="padding:10px 0;color:#888">Depósito</td>
          <td style="padding:10px 0;color:#0a0a0a;text-align:right">${flag} ${deposito}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#888">Estado anterior</td>
          <td style="padding:10px 0;color:#888;text-align:right;font-size:.82rem">${oldStatus}</td>
        </tr>
      </table>
      <div style="text-align:center">
        <a href="${process.env.PUBLIC_URL || 'http://localhost:' + PORT}"
           style="background:#0a0a0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;display:inline-block">
          Ver mi Panel
        </a>
      </div>
    </div>
    <div style="background:#f5f5f5;padding:18px 32px;border-top:1px solid #eee">
      <p style="color:#aaa;font-size:.75rem;margin:0;text-align:center">
        Arbox Argentina — 10 años de trayectoria en Comercio Exterior<br>
        Este es un mensaje automático, no respondas a este email.
      </p>
    </div>
  </div>
</body>
</html>`;

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || 'Arbox Argentina <noreply@arboxargentina.com>',
    to:      client.email,
    subject: `📦 Tu paquete cambió de estado: ${newStatus} — ${pkg.id}`,
    html,
  });

  console.log(`[email] Cambio de estado enviado a ${client.email} — ${pkg.id}: ${oldStatus} → ${newStatus}`);
}

// Mail resumido: UN solo email por cliente con TODOS sus paquetes que cambiaron de estado.
// Se usa en la actualización masiva del admin para no mandar un mail por paquete.
// changes: [{ pkg, oldStatus, newStatus }]
async function sendStatusDigestEmail(client, changes) {
  if (!client.email || !changes.length) return;
  const flagOf = d => ({ Miami: '🇺🇸', Madrid: '🇪🇸', China: '🇨🇳' }[d] || '');

  const rows = changes.map(ch => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem"><strong>${ch.pkg.id}</strong></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${ch.pkg.desc || ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${flagOf(ch.pkg.deposito)} ${ch.pkg.deposito || ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">
          <span style="color:#888">${ch.oldStatus}</span>
          <span style="color:#0a0a0a"> → </span>
          <strong style="color:#0a0a0a">${ch.newStatus}</strong>
        </td>
      </tr>`).join('');

  const html = `
    <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
    <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',sans-serif">
      <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
        <div style="background:#0a0a0a;padding:28px 32px">
          <div style="color:#fff;font-size:1.2rem;font-weight:800">Arbox Argentina</div>
          <div style="color:rgba(255,255,255,.5);font-size:.82rem;margin-top:4px">Actualización de tus paquetes</div>
        </div>
        <div style="padding:32px">
          <p style="color:#555;font-size:.95rem">Hola <strong style="color:#0a0a0a">${client.name}</strong>,</p>
          <p style="color:#555;font-size:.9rem">${changes.length === 1 ? 'Un paquete tuyo cambió de estado' : `${changes.length} de tus paquetes cambiaron de estado`}:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0">
            <thead><tr style="background:#f5f5f5">
              <th style="padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#888">Tracking</th>
              <th style="padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#888">Descripción</th>
              <th style="padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#888">Depósito</th>
              <th style="padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#888">Estado</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <div style="text-align:center;margin-top:24px">
            <a href="${process.env.PUBLIC_URL || 'http://localhost:' + PORT}"
               style="background:#0a0a0a;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:700;font-size:.9rem;display:inline-block">
              Ver mi Panel
            </a>
          </div>
        </div>
        <div style="background:#f5f5f5;padding:18px 32px;border-top:1px solid #eee">
          <p style="color:#aaa;font-size:.75rem;margin:0;text-align:center">
            Arbox Argentina — 10 años de trayectoria en Comercio Exterior<br>
            Este es un mensaje automático, no respondas a este email.
          </p>
        </div>
      </div>
    </body></html>`;

  await transporter.sendMail({
    from:    process.env.EMAIL_FROM || 'Arbox Argentina <noreply@arboxargentina.com>',
    to:      client.email,
    subject: changes.length === 1
      ? `📦 Tu paquete cambió de estado: ${changes[0].newStatus} — ${changes[0].pkg.id}`
      : `📦 Actualización de tus paquetes (${changes.length}) — Arbox Argentina`,
    html,
  });

  console.log(`[email] Resumen de estado enviado a ${client.email} — ${changes.length} paquete(s)`);
}

// ─── 17track API ──────────────────────────────────────────────────────────────
const TRACK17_BASE = 'https://api.17track.net/track/v2.2';
const TRACK17_HEADERS = {
  '17token':      process.env.TRACK17_API_KEY,
  'Content-Type': 'application/json',
};

// Identifica el carrier de un tracking number para decidir cómo trackearlo.
// Retorna:
//   'usps'   → usar USPS Web Tools API (17track carrier 21051 no soporta registro por API)
//   'tba'    → Amazon Logistics (TBA...), no soportado por 17track
//   null     → usar 17track con auto-detección (UPS 100002, FedEx 100003, DHL 100001,
//               China Post 3011, China EMS 3013, SF Express 100012, Yanwen 190012,
//               4PX 190094, Cainiao 190271, YTO 190157, ZTO 190175, etc.)
function detectCarrierType(trackingNumber) {
  const n = trackingNumber.trim().toUpperCase();
  // Amazon Logistics (TBA = "Tracking By Amazon") — no está en 17track API
  if (/^TBA\d{9,}$/.test(n)) return 'tba';
  // USPS — carrier 21051 existe en 17track pero retorna "temporarily does not support
  // registration" vía API. La web de 17track sí lo trackea. Usamos USPS Web Tools API.
  // Formatos: 9400, 9205, 9300, 9349, 9407, 9208, 9470, 9475... (20-22 dígitos)
  if (/^9[2-4]\d{18,20}$/.test(n)) return 'usps';
  return null; // 17track con auto-detect de carrier
}

// Registra un número de tracking en 17track para que empiece a ser monitoreado
async function register17track(trackingNumber) {
  const carrierType = detectCarrierType(trackingNumber);

  if (carrierType === 'tba') {
    console.log(`[17track] ${trackingNumber} es Amazon TBA — no soportado por 17track`);
    return { ok: false, reason: 'Amazon TBA no soportado', skip: true };
  }
  if (carrierType === 'usps') {
    console.log(`[17track] ${trackingNumber} es USPS — se trackea por USPS API, no 17track`);
    return { ok: false, reason: 'USPS se trackea por USPS API', skip: true };
  }

  try {
    const res = await axios.post(
      `${TRACK17_BASE}/register`,
      [{ number: trackingNumber }],
      { headers: TRACK17_HEADERS }
    );
    const { accepted = [], rejected = [] } = res.data?.data || {};
    if (accepted.length) {
      console.log(`[17track] Registrado: ${trackingNumber} (carrier ${accepted[0].carrier})`);
      return { ok: true, carrier: accepted[0].carrier };
    }
    const reason = rejected[0]?.error?.message || 'rechazado';
    console.warn(`[17track] No se pudo registrar ${trackingNumber}: ${reason}`);
    return { ok: false, reason };
  } catch (err) {
    console.error(`[17track] Error al registrar ${trackingNumber}:`, err.message);
    return { ok: false, reason: err.message };
  }
}

// ─── USPS Tracking API ────────────────────────────────────────────────────────
// USPS Web Tools API (gratuita): https://www.usps.com/business/web-tools-apis/
// Requiere USPS_USER_ID en .env (registro gratuito en usps.com)
async function getUSPSTrackInfo(trackingNumber) {
  const userId = process.env.USPS_USER_ID;
  if (!userId) {
    console.warn('[usps] USPS_USER_ID no configurado — saltando tracking USPS');
    return null;
  }
  const xml = `<TrackFieldRequest USERID="${userId}"><TrackID ID="${trackingNumber}"></TrackID></TrackFieldRequest>`;
  try {
    const res = await axios.get('https://secure.shippingapis.com/ShippingAPI.dll', {
      params: { API: 'TrackV2', XML: xml },
      timeout: 10000,
    });
    // Parsear XML a objeto simple
    const body = res.data;
    // Extraer eventos del XML (sin xml2js para no agregar dependencia)
    const summaryMatch = body.match(/<TrackSummary>([\s\S]*?)<\/TrackSummary>/);
    const detailMatches = [...body.matchAll(/<TrackDetail>([\s\S]*?)<\/TrackDetail>/g)];
    const errorMatch = body.match(/<Error>[\s\S]*?<Description>([\s\S]*?)<\/Description>/);
    if (errorMatch) {
      console.warn(`[usps] Error para ${trackingNumber}: ${errorMatch[1]}`);
      return null;
    }

    function parseEvent(xmlStr) {
      const get = (tag) => {
        const m = xmlStr.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`));
        return m ? m[1].trim() : '';
      };
      return {
        description: `${get('EventTime')} ${get('Event')}`.trim(),
        location:    [get('EventCity'), get('EventState'), get('EventZIPCode')].filter(Boolean).join(', '),
        stage:       get('Event'),
        rawEvent:    get('Event'),
      };
    }

    const events = [];
    if (summaryMatch) events.push(parseEvent(summaryMatch[1]));
    for (const m of detailMatches) events.push(parseEvent(m[1]));

    return { number: trackingNumber, carrier: 'usps', events };
  } catch (err) {
    console.error(`[usps] Error consultando ${trackingNumber}:`, err.message);
    return null;
  }
}

// Detecta llegada a depósito desde datos de USPS
function detectDepotArrivalUSPS(pkg, uspsInfo) {
  if (!uspsInfo?.events?.length) return false;
  const geoKws = DEPOT_GEO_KEYWORDS[pkg.deposito] || [];

  for (const event of uspsInfo.events) {
    const desc = (event.description || '').toLowerCase();
    const loc  = (event.location   || '').toLowerCase();
    const combined = `${desc} ${loc}`;
    const hasGeo    = geoKws.some(kw => combined.includes(kw.trim()));
    const hasAction = ARRIVAL_ACTION_KEYWORDS.some(kw => combined.includes(kw));
    // "DELIVERED" = llegó al depósito/destino en Miami/Madrid/China
    const isDelivered = /delivered|entregado/i.test(event.rawEvent || '');
    if (hasGeo && (hasAction || isDelivered)) {
      return { matched: true, description: event.description || event.rawEvent || 'Entregado en depósito' };
    }
  }
  return false;
}

// Consulta el estado de uno o varios trackings en 17track (máx 40 por request)
async function getTrackInfoBatch(trackingNumbers) {
  try {
    const res = await axios.post(
      `${TRACK17_BASE}/gettrackinfo`,
      trackingNumbers.map(n => ({ number: n })),
      { headers: TRACK17_HEADERS }
    );
    return res.data?.data?.accepted || [];
  } catch (err) {
    console.error('[17track] Error en getTrackInfoBatch:', err.message);
    return [];
  }
}

async function getTrackInfo(trackingNumber) {
  const results = await getTrackInfoBatch([trackingNumber]);
  return results[0] || null;
}

// ─── Detectar llegada al depósito de origen ───────────────────────────────────
//
// Keywords de ubicación por depósito (sin términos genéricos como "facility"):
// solo palabras que realmente identifiquen la geografía del depósito.
//
const DEPOT_GEO_KEYWORDS = {
  Miami: [
    'miami', 'florida', 'opa-locka', 'hialeah', 'doral', 'medley',
    ' fl ', 'fl,', 'mia,', ' mia ', 'united states', ' usa ', 'usa,', 'us,',
  ],
  Madrid: [
    'madrid', 'españa', 'spain', 'barajas', 'alcobendas', 'getafe',
    'iberia', 'correos', ' es,', ' es ', 'spain,',
  ],
  China: [
    'china', 'guangzhou', 'shenzhen', 'shanghai', 'yiwu', 'beijing',
    'hongkong', 'hong kong', 'guangdong', ' cn ', 'cn,',
    '已到达', '揽件', '分拣', '广州', '深圳', '上海',
  ],
};

// Verbos/sustantivos que indican recepción física en una instalación
const ARRIVAL_ACTION_KEYWORDS = [
  'arrived', 'arrival', 'received', 'delivered to', 'accepted',
  'inbound scan', 'picked up', 'in transit to', 'shipment received',
  'package received', 'out for delivery', 'llegó', 'llego', 'recibido',
  'en depósito', 'warehouse', 'facility', 'hub', 'cleared customs',
];

// Sub-statuses de 17track v2.2 que indican recepción/llegada a instalación
// (strings, no códigos enteros — eso era la API v1)
const ARRIVAL_SUBSTATUS_V2 = new Set([
  'InTransit_Arrival',
  'InTransit_PickedUp',
  'Pickup_Delivered',
  'Delivery_Delivered',
  'InfoReceived_Other',
]);

// Stage values de eventos v2.2 que indican recepción física
const ARRIVAL_STAGES = new Set(['PickedUp', 'Arrival', 'Delivery']);

// Construye la lista completa de eventos de un trackInfo v2.2
// Estructura: trackInfo.track_info.tracking.providers[].events[]
function extractAllEvents(trackInfo) {
  const ti = trackInfo?.track_info || {};
  const events = [];

  const providers = ti.tracking?.providers || [];
  for (const provider of providers) {
    if (Array.isArray(provider.events)) events.push(...provider.events);
  }

  // Fallback: latest_event si no hay eventos de providers
  if (!events.length && ti.latest_event) events.push(ti.latest_event);

  return events;
}

function detectDepotArrival(pkg, trackInfo) {
  if (!trackInfo) return false;

  const ti     = trackInfo.track_info || {};
  const geoKws = DEPOT_GEO_KEYWORDS[pkg.deposito] || [];

  // Helper: comprueba si texto + dirección coinciden con el depósito
  function matchesDepot(event) {
    const desc  = (event.description || '').toLowerCase();
    const loc   = (event.location   || '').toLowerCase();
    const city  = (event.address?.city    || '').toLowerCase();
    const country = (event.address?.country || '').toLowerCase();
    const combined = `${desc} ${loc} ${city} ${country}`;
    return geoKws.some(kw => combined.includes(kw.trim()));
  }

  const events = extractAllEvents(trackInfo);

  for (const event of events) {
    const hasGeoMatch  = matchesDepot(event);
    const hasActionKw  = ARRIVAL_ACTION_KEYWORDS.some(
      kw => (event.description || '').toLowerCase().includes(kw)
    );
    const hasArrivalStage = ARRIVAL_STAGES.has(event.stage);
    const hasArrivalSub   = ARRIVAL_SUBSTATUS_V2.has(ti.latest_status?.sub_status);

    // Regla 1: stage de llegada/entrega + geo del depósito
    if (hasArrivalStage && hasGeoMatch) {
      return { matched: true, description: event.description || 'Recibido en depósito de origen' };
    }
    // Regla 2: keyword de acción + geo del depósito
    if (hasActionKw && hasGeoMatch) {
      return { matched: true, description: event.description || 'Recibido en depósito de origen' };
    }
    // Regla 3: sub-status de llegada de 17track + geo del depósito
    if (hasArrivalSub && hasGeoMatch) {
      return { matched: true, description: event.description || 'Recibido en depósito de origen' };
    }
  }

  // Regla 4: latest_event directamente (por si extractAllEvents falla)
  if (ti.latest_event) {
    const ev = ti.latest_event;
    if (matchesDepot(ev) && (
      ARRIVAL_STAGES.has(ev.stage) ||
      ARRIVAL_ACTION_KEYWORDS.some(kw => (ev.description || '').toLowerCase().includes(kw))
    )) {
      return { matched: true, description: ev.description || 'Recibido en depósito de origen' };
    }
  }

  return false;
}

// ─── Sincronización activa (17track + USPS) ──────────────────────────────────
async function syncPackagesWith17track() {
  const db = loadDB();
  const toSync = db.packages.filter(
    p => p.estado === 'Registrado' && !p.id.startsWith('GC-')
  );

  if (!toSync.length) {
    console.log('[sync17] Sin paquetes en Registrado para sincronizar');
    return { synced: 0, updated: 0, reregistered: 0 };
  }

  // Separar USPS de los demás carriers
  const uspsPkgs  = toSync.filter(p => detectCarrierType(p.id) === 'usps');
  const tbaPkgs   = toSync.filter(p => detectCarrierType(p.id) === 'tba');
  const other17   = toSync.filter(p => detectCarrierType(p.id) === null);

  console.log(`[sync17] ${toSync.length} paquetes: ${other17.length} en 17track, ${uspsPkgs.length} USPS, ${tbaPkgs.length} TBA`);
  if (tbaPkgs.length) console.log(`[sync17] TBA (manuales): ${tbaPkgs.map(p => p.id).join(', ')}`);

  const BATCH = 40;
  let updated = 0;
  let reregistered = 0;
  let dbDirty = false;

  // ── Sync USPS via USPS API ──
  for (const pkg of uspsPkgs) {
    const uspsInfo = await getUSPSTrackInfo(pkg.id);
    if (!uspsInfo) continue;

    const latestDesc = uspsInfo.events[0]?.description || null;
    if (latestDesc && latestDesc !== pkg.ultimoEvento) {
      pkg.ultimoEvento = latestDesc;
      dbDirty = true;
    }

    const arrival = detectDepotArrivalUSPS(pkg, uspsInfo);
    if (!arrival) {
      console.log(`[usps] ${pkg.id} — sin llegada detectada (${uspsInfo.events[0]?.rawEvent || 'sin eventos'})`);
      continue;
    }

    addHistorialEntry(pkg, 'Recibido en origen');
    pkg.estado = 'Recibido en origen';
    pkg.ultimoEvento = arrival.description;
    dbDirty = true;
    updated++;
    console.log(`[usps] ✓ ${pkg.id} → Recibido en origen`);

    if (!pkg.notificado) {
      const client = db.clients.find(c => c.id === pkg.clientId);
      if (client?.email) {
        try {
          await sendArrivalEmail(client, pkg, arrival.description);
          pkg.notificado = true;
        } catch (err) {
          console.error(`[usps] Error enviando email para ${pkg.id}:`, err.message);
        }
      }
    }
  }

  // ── Sync 17track (todos menos USPS y TBA) ──
  for (let i = 0; i < other17.length; i += BATCH) {
    const batch = other17.slice(i, i + BATCH);

    let accepted = [];
    let rejected = [];
    try {
      const res = await axios.post(
        `${TRACK17_BASE}/gettrackinfo`,
        batch.map(p => ({ number: p.id })),
        { headers: TRACK17_HEADERS }
      );
      accepted = res.data?.data?.accepted || [];
      rejected = res.data?.data?.rejected || [];
    } catch (err) {
      console.error('[sync17] Error consultando 17track:', err.message);
      continue;
    }

    // Re-registrar paquetes que 17track no conoce
    for (const rej of rejected) {
      const errCode = rej.error?.code;
      // -18019902 = not registered, re-register it
      if (errCode === -18019902 || errCode === -18019909) {
        console.log(`[sync17] ${rej.number} no registrado (${rej.error?.message}) — re-registrando`);
        const result = await register17track(rej.number);
        if (result.ok) reregistered++;
      } else {
        console.log(`[sync17] ${rej.number} rechazado: ${rej.error?.message}`);
      }
    }

    for (const trackInfo of accepted) {
      const trackingNumber = trackInfo.number;
      const pkg = db.packages.find(p => p.id === trackingNumber);
      if (!pkg) continue;

      // Actualizar ultimoEvento con el evento más reciente, siempre
      const events = extractAllEvents(trackInfo);
      const latestDesc = events[0]?.description
        || trackInfo.track_info?.latest_event?.description
        || null;
      if (latestDesc && latestDesc !== pkg.ultimoEvento) {
        pkg.ultimoEvento = latestDesc;
        dbDirty = true;
      }

      const arrival = detectDepotArrival(pkg, trackInfo);
      if (!arrival) {
        const status = trackInfo.track_info?.latest_status?.sub_status || 'sin datos';
        console.log(`[sync17] ${trackingNumber} — sin llegada detectada (sub_status: ${status})`);
        continue;
      }

      addHistorialEntry(pkg, 'Recibido en origen');
      pkg.estado       = 'Recibido en origen';
      pkg.ultimoEvento = arrival.description;
      dbDirty = true;
      updated++;
      console.log(`[sync17] ✓ ${trackingNumber} → Recibido en origen (${arrival.description})`);

      if (!pkg.notificado) {
        const client = db.clients.find(c => c.id === pkg.clientId);
        if (client?.email) {
          try {
            await sendArrivalEmail(client, pkg, arrival.description);
            pkg.notificado = true;
          } catch (err) {
            console.error(`[sync17] Error enviando email para ${trackingNumber}:`, err.message);
          }
        }
      }
    }
  }

  if (dbDirty) saveDB(db, 'sync17track');
  console.log(`[sync17] Completado: ${updated} actualizados, ${reregistered} re-registrados de ${toSync.length} paquetes`);
  return { synced: toSync.length, updated, reregistered };
}

// ─── Verificación de firma del webhook ───────────────────────────────────────
// 17track v2.2 firma así: SHA256(rawBody + "/" + api_key)
// Ref: https://asset.17track.net/api/document/v2_en/index.html
function verifyWebhookSignature(rawBody, receivedSign) {
  if (!receivedSign) {
    console.warn('[webhook] Sin header de firma — permitido');
    return true;
  }

  const apiKey = process.env.TRACK17_API_KEY;
  const secret = process.env.TRACK17_WEBHOOK_SECRET;

  if (!apiKey && !secret) {
    console.warn('[webhook] Sin credenciales configuradas — skipping verificación');
    return true;
  }

  const body = rawBody.toString();

  // Método correcto v2.2: SHA256(rawBody + "/" + api_key)
  if (apiKey) {
    const m = crypto.createHash('sha256').update(body + '/' + apiKey).digest('hex');
    if (m === receivedSign) { console.log('[webhook] Firma OK (método v2.2 api_key)'); return true; }
  }

  // Fallback con webhook secret configurado en el portal
  if (secret) {
    const m = crypto.createHash('sha256').update(body + '/' + secret).digest('hex');
    if (m === receivedSign) { console.log('[webhook] Firma OK (método v2.2 webhook_secret)'); return true; }
  }

  // Fallback legado sin slash
  if (apiKey) {
    const m = crypto.createHash('sha256').update(body + apiKey).digest('hex');
    if (m === receivedSign) { console.log('[webhook] Firma OK (método legado)'); return true; }
  }

  console.warn(`[webhook] Firma INVÁLIDA. Recibida: ${receivedSign.substring(0,16)}...`);
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS API
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requerido' });
  const db = loadDB();
  const client = db.clients.find(c => c.email?.toLowerCase() === email.toLowerCase().trim());
  if (!client) return res.json({ ok: true }); // no revelar si existe
  const tempPass = Math.random().toString(36).slice(2, 8).toUpperCase();
  client.password = tempPass;
  saveDB(db, 'forgot-password');
  try {
    await transporter.sendMail({
      from: `"Arbox Argentina" <${process.env.SMTP_USER}>`,
      to: client.email,
      subject: '🔐 Tu nueva contraseña temporal — Arbox Argentina',
      html: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',sans-serif">
<div style="max-width:520px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
  <div style="background:#0a0a0a;padding:24px 28px">
    <div style="color:#fff;font-size:1.1rem;font-weight:800">Arbox Argentina</div>
    <div style="color:rgba(255,255,255,.5);font-size:.8rem;margin-top:4px">Recuperación de contraseña</div>
  </div>
  <div style="padding:28px">
    <p style="color:#333;margin-bottom:16px">Hola <strong>${client.name}</strong>,</p>
    <p style="color:#555;margin-bottom:20px">Recibimos una solicitud de recuperación de contraseña para tu cuenta.</p>
    <div style="background:#f5f5f5;border-radius:8px;padding:18px;text-align:center;margin-bottom:20px">
      <div style="font-size:.75rem;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Tu contraseña temporal</div>
      <div style="font-size:2rem;font-weight:900;letter-spacing:.15em;color:#0a0a0a">${tempPass}</div>
    </div>
    <p style="color:#888;font-size:.85rem">Ingresá con esta contraseña y cambiala desde tu perfil. Si no solicitaste este cambio, ignorá este email.</p>
  </div>
</div></body></html>`,
    });
  } catch (err) {
    console.error('[forgot-password] Error enviando email:', err.message);
  }
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Ingresá usuario y contraseña' });
    }

    const userLower = String(username).toLowerCase();

    // Verificar superadmin (null-safe: un admin puede estar configurado por email o por usuario)
    const sa = SUPERADMINS.find(
      s => (userLower === (s.email || '').toLowerCase() || userLower === (s.username || '').toLowerCase())
           && password === s.password
    );
    if (sa) {
      return res.json({
        ok: true,
        role: 'superadmin',
        adminToken: ADMIN_TOKEN,
        client: { id: 'admin', name: sa.name, email: sa.email, role: 'superadmin' }
      });
    }

    const db = loadDB();
    const client = (db.clients || []).find(
      c => (c.username?.toLowerCase() === userLower || c.email?.toLowerCase() === userLower) && c.password === password
    );
    if (!client) return res.status(401).json({ error: 'Credenciales incorrectas' });
    const { password: _pw, ...clientData } = client;
    res.json({ ok: true, client: clientData });
  } catch (err) {
    console.error('[login] Error inesperado:', err.message);
    return res.status(500).json({ error: 'Error del servidor. Intentá de nuevo.' });
  }
});

// ─── Registro público ────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
  const { name, email, username, password, phone } = req.body;
  if (!name || !username || !password || !email || !phone) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios (incluido el teléfono)' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  const db = loadDB();
  if (db.clients.find(c => c.username?.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso' });
  }
  if (db.clients.find(c => c.email?.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Ese email ya está registrado' });
  }
  const newClient = {
    id: Date.now().toString(),
    name,
    email,
    phone,
    username,
    password,
  };
  db.clients.push(newClient);
  saveDB(db, 'register-client');
  const { password: _pw, ...clientData } = newClient;
  res.status(201).json({ ok: true, client: clientData });
});

// Datos de una invitación (público): nombre + paquetes, para la página de invitación.
app.get('/api/invitacion/:token', (req, res) => {
  const db = loadDB();
  const invites = db.invites || {};
  const token = req.params.token;
  if (!Object.prototype.hasOwnProperty.call(invites, token)) return res.json({ valid: false });
  const invite = invites[token];
  if (invite.usedAt) return res.json({ valid: false });
  const packages = invite.packageIds
    .map(id => { const p = db.packages.find(x => x.id === id); return p ? { id: p.id, desc: p.desc, estado: p.estado } : null; })
    .filter(Boolean);
  res.json({ valid: true, name: invite.name, packages });
});

// Alta con token de invitación (público): crea la cuenta, reclama los paquetes y devuelve la sesión.
app.post('/api/auth/register-invite', (req, res) => {
  const { token, email, password, phone } = req.body;
  if (!token || !email || !password) return res.status(400).json({ error: 'Faltan datos (email y contraseña)' });
  if (String(password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  const db = loadDB();
  const invites = db.invites || {};
  if (!Object.prototype.hasOwnProperty.call(invites, token)) return res.status(404).json({ error: 'Invitación inválida' });
  const invite = invites[token];
  if (invite.usedAt) return res.status(400).json({ error: 'Esta invitación ya fue utilizada. Iniciá sesión con tu cuenta.' });
  if (db.clients.find(c => c.email?.toLowerCase() === email.toLowerCase())) {
    return res.status(400).json({ error: 'Ese email ya está registrado. Iniciá sesión con tu cuenta.' });
  }
  // Derivar un username único a partir del email
  let base = (String(email).split('@')[0] || 'cliente').toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'cliente';
  let username = base, n = 1;
  while (db.clients.find(c => c.username?.toLowerCase() === username.toLowerCase())) username = base + (++n);
  const newClient = { id: Date.now().toString(), name: invite.name, email, phone: phone || '', username, password };
  db.clients.push(newClient);
  // Reclamar los paquetes del invite (idempotente: saltea los ya tomados)
  let claimed = 0;
  for (const pid of invite.packageIds) {
    const pkg = db.packages.find(p => p.id === pid);
    if (pkg && !(pkg.clientId && !pkg.unassigned)) { pkg.clientId = newClient.id; pkg.unassigned = false; claimed++; }
  }
  invite.usedAt = Date.now();
  saveDB(db, 'register-invite');
  const { password: _pw, ...clientData } = newClient;
  res.status(201).json({ ok: true, client: clientData, claimed });
});

// ─── Paquetes ─────────────────────────────────────────────────────────────────
app.get('/api/packages/:clientId', (req, res) => {
  const db = loadDB();
  const pkgs = db.packages.filter(p => p.clientId === req.params.clientId);
  res.json(pkgs);
});

const ESTADOS_VALIDOS = ['Registrado', 'Recibido en origen', 'En tránsito', 'Clasificando en BsAs', 'Listo para entrega', 'Entregado'];

app.post('/api/packages', async (req, res) => {
  const { clientId, deposito, tracking, desc, peso, valor, remitente, obs, estado } = req.body;
  if (!clientId || !deposito || !desc) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const db = loadDB();
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

  // Generar tracking si no se proveyó
  const trackingId = tracking?.trim() || `GC-${Math.floor(Math.random() * 900000 + 100000)}`;
  const pesoNum    = parseFloat(peso) || 0;
  const valorNum   = parseFloat(valor) || 0;
  // Estado inicial: por defecto "Registrado". El escáner por-cliente puede pedir otro.
  const estadoInicial = ESTADOS_VALIDOS.includes(estado) ? estado : 'Registrado';
  const hoy = new Date().toISOString().split('T')[0];

  // Validar que el tracking no esté duplicado
  if (db.packages.find(p => p.id === trackingId)) {
    return res.status(400).json({ error: 'Ese número de tracking ya está registrado' });
  }

  const pkg = {
    id:        trackingId,
    clientId,
    deposito,
    desc,
    peso:      pesoNum,
    valor:     valorNum,
    costo:     0,
    remitente: remitente || '',
    obs:       obs || '',
    estado:    estadoInicial,
    fecha:     hoy,
    pagado:    false,
    notificado: false,
    documents: deposito === 'China' ? [] : null,
    historial: [{ estado: estadoInicial, fecha: hoy, ts: Date.now() }],
  };

  db.packages.push(pkg);
  saveDB(db, 'create-package');
  res.status(201).json({ ok: true, package: pkg });

  // Registrar en 17track en segundo plano (solo si el tracking parece real, no autogenerado GC-).
  if (!trackingId.startsWith('GC-')) {
    register17track(trackingId)
      .then(result => { if (!result.ok) console.warn(`[17track] No se pudo registrar el tracking ${trackingId}: ${result.reason}`); })
      .catch(e => console.warn(`[17track] Error registrando ${trackingId}: ${e.message}`));
  }
});

// ─── Paquetes "No asignados" (intake Miami) ─────────────────────────────────
// Crear un paquete no asignado desde el escáner (cuando el tracking no matchea)
app.post('/api/admin/unassigned', requireAdmin, (req, res) => {
  const { tracking, deposito, destinatario, desc } = req.body;
  const trackingId = (tracking || '').trim();
  if (!trackingId) return res.status(400).json({ error: 'Falta el tracking' });
  const db = loadDB();
  if (db.packages.find(p => p.id === trackingId)) {
    return res.status(409).json({ error: 'Ese tracking ya está registrado', duplicate: true });
  }
  const hoy = new Date().toISOString().split('T')[0];
  const pkg = {
    id: trackingId, clientId: null, unassigned: true,
    destinatario: destinatario || '', deposito: deposito || 'Miami',
    desc: desc || 'Paquete recibido (sin asignar)',
    peso: 0, valor: 0, costo: 0, remitente: '', obs: '',
    estado: 'Recibido en origen', fecha: hoy,
    pagado: false, notificado: false, documents: null,
    historial: [{ estado: 'Recibido en origen', fecha: hoy, ts: Date.now() }],
  };
  db.packages.push(pkg);
  saveDB(db, 'scan-unassigned');
  res.status(201).json({ ok: true, package: pkg });
});

// Asignar un paquete a un cliente (+ email de recibido)
app.put('/api/admin/packages/:id/assign', requireAdmin, async (req, res) => {
  const { clientId } = req.body;
  const db  = loadDB();
  const pkg = db.packages.find(p => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: 'Paquete no encontrado' });
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  pkg.clientId = clientId;
  pkg.unassigned = false;
  saveDB(db, 'assign-package');
  res.json({ ok: true, package: pkg });
  // Email de arribo en segundo plano. Al marcar notificado se relee la base FRESCA
  // (no se re-guarda el snapshot viejo, para no pisar asignaciones concurrentes).
  if (client.email && !pkg.notificado) {
    sendArrivalEmail(client, pkg, pkg.ultimoEvento || 'Recibido en depósito')
      .then(() => {
        const fresh = loadDB();
        const fp = fresh.packages.find(p => p.id === pkg.id);
        if (fp && !fp.notificado) { fp.notificado = true; saveDB(fresh, 'assign-email'); }
      })
      .catch(e => console.error('[assign] email:', e.message));
  }
});

// Reclamo del cliente: asigna un paquete no asignado que matchee el tracking
app.post('/api/packages/claim', (req, res) => {
  const { clientId, tracking } = req.body;
  const trackingId = (tracking || '').trim();
  if (!clientId || !trackingId) return res.status(400).json({ error: 'Faltan datos' });
  const db = loadDB();
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  const pkg = db.packages.find(p => p.id === trackingId);
  if (!pkg) return res.status(404).json({ error: 'No encontramos un paquete con ese tracking.' });
  if (pkg.clientId && !pkg.unassigned) {
    return res.status(409).json({ error: 'Ese paquete ya está asignado a una cuenta.' });
  }
  pkg.clientId = clientId;
  pkg.unassigned = false;
  saveDB(db, 'claim-package');
  res.json({ ok: true, package: pkg });
});

// Seguimiento real (17track) de un paquete — cache liviano de 15 min
app.get('/api/packages/:id/tracking', async (req, res) => {
  const { clientId } = req.query;
  const db  = loadDB();
  const pkg = db.packages.find(p => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ available: false, motivo: 'Paquete no encontrado' });
  if (clientId && pkg.clientId && pkg.clientId !== clientId) {
    return res.status(403).json({ available: false, motivo: 'No autorizado' });
  }
  if (!process.env.TRACK17_API_KEY) return res.json({ available: false, motivo: 'Seguimiento no disponible por ahora.' });
  if (!pkg.id || pkg.id.startsWith('GC-')) return res.json({ available: false, motivo: 'Este envío no tiene número de seguimiento del courier.' });

  const FRESH = 15 * 60 * 1000;
  if (pkg.trackCache && (Date.now() - pkg.trackCache.fetchedAt) < FRESH) {
    const ev = pkg.trackCache.events || [];
    return res.json({ available: ev.length > 0, carrier: pkg.trackCache.carrier, events: ev, motivo: ev.length ? undefined : 'Todavía no hay eventos del courier.', cached: true });
  }
  try {
    const ti  = await getTrackInfo(pkg.id);
    const raw = extractAllEvents(ti);
    const events = raw.map(e => ({
      fecha:       e.time_iso || e.time_utc || '',
      descripcion: e.description || '',
      ubicacion:   e.location || [e.address?.city, e.address?.state, e.address?.country].filter(Boolean).join(', '),
    })).filter(e => e.descripcion || e.ubicacion);
    const carrier = ti?.track_info?.tracking?.providers?.[0]?.provider?.name || '';
    pkg.trackCache = { fetchedAt: Date.now(), carrier, events };
    saveDB(db, 'track-cache');
    if (!events.length) return res.json({ available: false, motivo: 'Todavía no hay eventos del courier para este envío.' });
    res.json({ available: true, carrier, events });
  } catch (e) {
    console.error('[tracking]', e.message);
    res.json({ available: false, motivo: 'No pudimos obtener el seguimiento en este momento.' });
  }
});

// ─── Editar paquete propio (cliente) — solo en estado "Registrado" ───────────
app.put('/api/packages/:id/client-edit', async (req, res) => {
  const { clientId, desc, deposito, tracking, peso, valor, remitente, obs } = req.body;
  if (!clientId) return res.status(400).json({ error: 'Falta clientId' });

  const db = loadDB();
  const idx = db.packages.findIndex(p => p.id === req.params.id && p.clientId === clientId);
  if (idx === -1) return res.status(404).json({ error: 'Paquete no encontrado' });

  const pkg = db.packages[idx];
  if (pkg.estado !== 'Registrado') {
    return res.status(403).json({ error: 'Solo se pueden editar paquetes en estado "Registrado"' });
  }

  if (desc      !== undefined) pkg.desc      = desc;
  if (deposito  !== undefined) pkg.deposito  = deposito;
  if (peso      !== undefined) pkg.peso      = parseFloat(peso) || 0;
  if (valor     !== undefined) pkg.valor     = parseFloat(valor) || 0;
  if (remitente !== undefined) pkg.remitente = remitente;
  if (obs       !== undefined) pkg.obs       = obs;

  // Cambio de tracking: actualiza el ID del paquete
  const newTracking = tracking?.trim();
  let trackingToRegister = null;
  if (newTracking && newTracking !== pkg.id) {
    if (db.packages.find(p => p.id === newTracking)) {
      return res.status(400).json({ error: 'Ese número de tracking ya existe' });
    }
    pkg.id = newTracking;
    if (!newTracking.startsWith('GC-')) trackingToRegister = newTracking;
  }

  saveDB(db, 'client-edit-package');
  res.json({ ok: true, package: pkg });
  // Registro en 17track en segundo plano.
  if (trackingToRegister) {
    register17track(trackingToRegister)
      .then(result => { if (!result.ok) console.warn(`[17track] No se pudo registrar ${trackingToRegister}: ${result.reason}`); })
      .catch(e => console.warn(`[17track] Error registrando ${trackingToRegister}: ${e.message}`));
  }
});

// ─── Actualizar estado de paquete (cliente) ──────────────────────────────────
app.put('/api/packages/:id/status', async (req, res) => {
  const { clientId, estado } = req.body;
  if (!clientId || !estado) return res.status(400).json({ error: 'Faltan datos' });
  const db = loadDB();
  const client = db.clients.find(c => c.id === clientId);
  const pkg = db.packages.find(p => p.id === req.params.id && p.clientId === clientId);
  if (!pkg) return res.status(404).json({ error: 'Paquete no encontrado' });
  const validStates = ['Registrado','Recibido en origen','En depósito','En tránsito','En viaje','Clasificando en BsAs','Listo para entrega','Entregado','Retenido'];
  if (!validStates.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const oldStatus = pkg.estado;
  applyETA(pkg, estado);
  pkg.estado = estado;
  addHistorialEntry(pkg, estado);
  saveDB(db, 'client-update-status');
  res.json({ ok: true, package: pkg });
  // Notificación en segundo plano: no bloquea la respuesta.
  if (client && oldStatus !== estado) {
    sendStatusChangeEmail(client, pkg, oldStatus, estado).catch(e => console.error('[status] email falló:', e.message));
  }
});

// ─── Documentos (facturas/packing list) ──────────────────────────────────────
app.post('/api/packages/:id/documents', (req, res) => {
  const { clientId, documentType, fileData, fileName } = req.body;
  if (!clientId || !documentType || !fileData || !fileName) {
    return res.status(400).json({ error: 'Faltan datos requeridos' });
  }

  const db = loadDB();
  const pkg = db.packages.find(p => p.id === req.params.id && p.clientId === clientId);
  if (!pkg) return res.status(404).json({ error: 'Paquete no encontrado' });

  // Solo se pueden agregar documentos a paquetes China
  if (pkg.deposito !== 'China') {
    return res.status(403).json({ error: 'Solo se pueden agregar documentos a depósitos China' });
  }

  // Solo en estado "Registrado"
  if (pkg.estado !== 'Registrado') {
    return res.status(403).json({ error: 'Solo se pueden agregar documentos a paquetes en estado Registrado' });
  }

  // Decodificar el archivo base64
  const buf = Buffer.from(fileData.split(',')[1] || fileData, 'base64');
  const docId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const fileExt = fileName.split('.').pop().toLowerCase();
  const savedFileName = `${req.params.id}_${docId}.${fileExt}`;
  const filePath = path.join(DOCS_DIR, savedFileName);

  try {
    fs.writeFileSync(filePath, buf);

    const doc = {
      id: docId,
      type: documentType,
      fileName,
      savedFileName,
      uploadDate: new Date().toISOString(),
      size: buf.length,
    };

    if (!pkg.documents) pkg.documents = [];
    pkg.documents.push(doc);

    db.documents[req.params.id] = db.documents[req.params.id] || [];
    db.documents[req.params.id].push(doc);

    saveDB(db, 'upload-document');
    res.status(201).json({ ok: true, document: doc });
  } catch (err) {
    console.error('[docs] Error al guardar documento:', err.message);
    res.status(500).json({ error: 'Error al guardar el documento' });
  }
});

app.get('/api/packages/:id/documents', (req, res) => {
  const { clientId } = req.query;
  const db = loadDB();
  const pkg = db.packages.find(p => p.id === req.params.id);

  if (!pkg) return res.status(404).json({ error: 'Paquete no encontrado' });

  // Los clientes solo ven sus propios documentos
  if (clientId && pkg.clientId !== clientId) {
    return res.status(403).json({ error: 'Sin acceso a este paquete' });
  }

  res.json(pkg.documents || []);
});

app.get('/api/packages/:id/documents/:docId/download', (req, res) => {
  const { clientId } = req.query;
  const db = loadDB();
  const pkg = db.packages.find(p => p.id === req.params.id);

  if (!pkg) return res.status(404).json({ error: 'Paquete no encontrado' });

  // Sin clientId = es admin; con clientId = verificar que sea propietario
  if (clientId && pkg.clientId !== clientId) {
    return res.status(403).json({ error: 'Sin acceso' });
  }

  const doc = pkg.documents?.find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado' });

  const filePath = path.join(DOCS_DIR, doc.savedFileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Archivo no encontrado en servidor' });
  }

  res.download(filePath, doc.fileName);
});

app.delete('/api/packages/:id/documents/:docId', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'Falta clientId' });

  const db = loadDB();
  const pkg = db.packages.find(p => p.id === req.params.id && p.clientId === clientId);
  if (!pkg) return res.status(404).json({ error: 'Paquete no encontrado' });

  const docIdx = pkg.documents?.findIndex(d => d.id === req.params.docId);
  if (docIdx === undefined || docIdx === -1) {
    return res.status(404).json({ error: 'Documento no encontrado' });
  }

  const doc = pkg.documents[docIdx];
  const filePath = path.join(DOCS_DIR, doc.savedFileName);

  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    pkg.documents.splice(docIdx, 1);
    saveDB(db, 'delete-document');
    res.json({ ok: true });
  } catch (err) {
    console.error('[docs] Error al eliminar documento:', err.message);
    res.status(500).json({ error: 'Error al eliminar documento' });
  }
});

// ─── Cuenta corriente ─────────────────────────────────────────────────────────
app.get('/api/movements/:clientId', (req, res) => {
  const db  = loadDB();
  const mvs = db.movements.filter(m => m.clientId === req.params.clientId);
  res.json(mvs);
});

// (Eliminado POST /api/payments: sin autenticación y sin llamador — permitía acreditar
//  pagos a cualquier cuenta. El flujo real de pagos es POST /api/admin/payments, con auth.)

// ─── Clientes (admin) ─────────────────────────────────────────────────────────
app.get('/api/clients', (req, res) => {
  const db = loadDB();
  res.json(db.clients.map(({ password: _pw, ...c }) => c));
});

// ═══════════════════════════════════════════════════════════════════════════════
// RUTAS SUPERADMIN
// ═══════════════════════════════════════════════════════════════════════════════

// Todos los paquetes con nombre de cliente
app.get('/api/admin/packages', requireAdmin, (req, res) => {
  const db = loadDB();
  const enriched = db.packages.map(p => {
    const client = db.clients.find(c => c.id === p.clientId);
    return { ...p, clientName: client?.name || p.clientId, clientEmail: client?.email || '' };
  });
  res.json(enriched);
});

// Todos los movimientos con nombre de cliente
app.get('/api/admin/movements', requireAdmin, (req, res) => {
  const db = loadDB();
  const enriched = db.movements.map(m => {
    const client = db.clients.find(c => c.id === m.clientId);
    const del = m.deliveryToken ? (db.deliveries || {})[m.deliveryToken] : null;
    return { ...m, clientName: client?.name || m.clientId, delivered: del ? !!del.delivered : null };
  });
  res.json(enriched);
});

// Todos los clientes con sus paquetes y saldo
app.get('/api/admin/clients', requireAdmin, (req, res) => {
  const db = loadDB();
  const result = db.clients.map(({ password: _pw, ...c }) => {
    const pkgs = db.packages.filter(p => p.clientId === c.id);
    const mvs  = db.movements.filter(m => m.clientId === c.id);
    const saldo = mvs.reduce((acc, m) => acc + m.monto, 0);
    return { ...c, packages: pkgs, movements: mvs, saldo: +saldo.toFixed(2) };
  });
  res.json(result);
});

// Editar paquetes en bulk
app.put('/api/admin/packages/bulk', requireAdmin, async (req, res) => {
  const { ids, fields } = req.body;
  if (!Array.isArray(ids) || !ids.length || !fields) return res.status(400).json({ error: 'Datos inválidos' });
  const db = loadDB();
  const allowed = ['estado','desc','peso','costo','deposito','obs','remitente','pagado','valor','fecha','fechaArriboBsAs','fechaEstimadaEntrega'];
  let updated = 0;
  const toNotify = [];
  for (const id of ids) {
    const idx = db.packages.findIndex(p => p.id === id);
    if (idx === -1) continue;
    const oldStatus = db.packages[idx].estado;
    if (fields.estado && fields.estado !== oldStatus) applyETA(db.packages[idx], fields.estado);
    allowed.forEach(k => { if (fields[k] !== undefined) db.packages[idx][k] = fields[k]; });
    if (fields.estado && fields.estado !== oldStatus) {
      addHistorialEntry(db.packages[idx], fields.estado);
      const pkg = db.packages[idx];
      const client = db.clients.find(c => c.id === pkg.clientId);
      // Se junta la notificación y se envía DESPUÉS de responder (no en serie dentro del loop).
      if (client) toNotify.push({ client, pkg: { ...pkg }, oldStatus, newStatus: fields.estado });
    }
    updated++;
  }
  saveDB(db, 'admin-bulk-update');
  res.json({ ok: true, updated });
  // Notificaciones en segundo plano: UN mail resumido por cliente (no uno por paquete),
  // así un cliente con 50 paquetes recibe un solo email con todos los cambios.
  if (toNotify.length) {
    const byClient = new Map();
    for (const n of toNotify) {
      const entry = byClient.get(n.client.id) || { client: n.client, changes: [] };
      entry.changes.push({ pkg: n.pkg, oldStatus: n.oldStatus, newStatus: n.newStatus });
      byClient.set(n.client.id, entry);
    }
    const digests = [...byClient.values()];
    Promise.allSettled(digests.map(e => sendStatusDigestEmail(e.client, e.changes)))
      .then(rs => { const fail = rs.filter(r => r.status === 'rejected').length; if (fail) console.error(`[bulk] ${fail}/${digests.length} mails resumidos fallaron`); });
  }
});

// Alta batch de paquetes desde manifiesto (idempotente, SIN email).
// body: { items: [{ id, clientId|null, peso, deposito, desc, estado }] }
app.post('/api/admin/packages/ingest', requireAdmin, (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items inválido' });
  const db = loadDB();
  const hoy = new Date().toISOString().split('T')[0];
  let creados = 0, omitidos = 0;
  const validStates = ['Registrado','Recibido en origen','En depósito','En tránsito','En viaje','Clasificando en BsAs','Listo para entrega','Entregado','Retenido'];
  for (const it of items) {
    const id = String(it.id || '').trim();
    if (!id) { omitidos++; continue; }
    if (db.packages.find(p => p.id === id)) { omitidos++; continue; }      // idempotente
    const estado = validStates.includes(it.estado) ? it.estado : 'En tránsito';
    const assigned = it.clientId && db.clients.find(c => c.id === it.clientId);
    db.packages.push({
      id, clientId: assigned ? it.clientId : null, unassigned: !assigned,
      destinatario: it.destinatario || '', deposito: it.deposito || 'Miami',
      desc: it.desc || 'Paquete en tránsito (manifiesto)',
      peso: parseFloat(it.peso) || 0, valor: 0, costo: 0, remitente: '', obs: '',
      ...(it.fechaArriboBsAs ? { fechaArriboBsAs: it.fechaArriboBsAs } : {}),
      ...(it.fechaEstimadaEntrega ? { fechaEstimadaEntrega: it.fechaEstimadaEntrega } : {}),
      estado, fecha: hoy, pagado: false, notificado: false, documents: null,
      historial: [{ estado, fecha: hoy, ts: Date.now() }],
    });
    creados++;
  }
  saveDB(db, 'manifiesto-ingest');
  res.status(201).json({ ok: true, creados, omitidos });
});

// Crear una invitación para un cliente sin cuenta (agrupa sus paquetes "por asignar").
app.post('/api/admin/invites', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Falta el nombre' });
  const db = loadDB();
  const packageIds = db.packages
    .filter(p => p.unassigned && String(p.destinatario || '').trim() === name)
    .map(p => p.id);
  if (!packageIds.length) return res.status(400).json({ error: 'Ese cliente no tiene paquetes sin asignar' });
  db.invites = db.invites || {};
  const token = crypto.randomBytes(16).toString('hex');
  db.invites[token] = { name, packageIds, createdAt: Date.now(), usedAt: null };
  saveDB(db, 'crear-invitacion');
  const origin = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  res.status(201).json({ ok: true, token, url: `${origin}/invitacion/${token}`, count: packageIds.length });
});

// Editar paquete
app.put('/api/admin/packages/:id', requireAdmin, async (req, res) => {
  const db  = loadDB();
  const idx = db.packages.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Paquete no encontrado' });
  const allowed = ['estado','desc','peso','costo','deposito','obs','remitente','pagado','valor','fecha','fechaArriboBsAs','fechaEstimadaEntrega'];
  const oldStatus = db.packages[idx].estado;
  if (req.body.estado && req.body.estado !== oldStatus) applyETA(db.packages[idx], req.body.estado);
  allowed.forEach(k => { if (req.body[k] !== undefined) db.packages[idx][k] = req.body[k]; });
  let notify = null;
  if (req.body.estado && req.body.estado !== oldStatus) {
    addHistorialEntry(db.packages[idx], req.body.estado);
    const pkg = db.packages[idx];
    const client = db.clients.find(c => c.id === pkg.clientId);
    if (client) notify = { client, pkg: { ...pkg }, oldStatus, newStatus: req.body.estado };
  }
  saveDB(db, 'admin-edit-package');
  res.json({ ok: true, package: db.packages[idx] });
  // Notificación en segundo plano: no bloquea la respuesta.
  if (notify) sendStatusChangeEmail(notify.client, notify.pkg, notify.oldStatus, notify.newStatus).catch(e => console.error('[admin-edit] email falló:', e.message));
});

// Eliminar paquete
app.delete('/api/admin/packages/:id', requireAdmin, (req, res) => {
  const db  = loadDB();
  const idx = db.packages.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Paquete no encontrado' });
  db.packages.splice(idx, 1);
  db.movements = db.movements.filter(m => m.ref !== req.params.id);
  saveDB(db, 'admin-delete-package');
  res.json({ ok: true });
});

// Editar cliente
app.put('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const db  = loadDB();
  const idx = db.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Cliente no encontrado' });
  const allowed = ['name','email','phone','username','password','cuit','precioKg'];
  allowed.forEach(k => { if (req.body[k] !== undefined) db.clients[idx][k] = req.body[k]; });
  // precioKg: normalizar a número (o quitar si viene vacío/inválido)
  if (req.body.precioKg !== undefined) {
    const pk = parseFloat(req.body.precioKg);
    if (Number.isFinite(pk) && pk > 0) db.clients[idx].precioKg = pk;
    else delete db.clients[idx].precioKg;
  }
  saveDB(db, 'admin-edit-client');
  const { password: _pw, ...clientData } = db.clients[idx];
  res.json({ ok: true, client: clientData });
});

// Eliminar cliente
app.delete('/api/admin/clients/:id', requireAdmin, (req, res) => {
  const db  = loadDB();
  const idx = db.clients.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Cliente no encontrado' });
  const hasPkgs = db.packages.some(p => p.clientId === req.params.id);
  if (hasPkgs) return res.status(400).json({ error: 'El cliente tiene paquetes asociados' });
  db.clients.splice(idx, 1);
  saveDB(db, 'admin-delete-client');
  res.json({ ok: true });
});

// Crear cliente
app.post('/api/admin/clients', requireAdmin, (req, res) => {
  const { name, email, username, password } = req.body;
  if (!name || !username || !password) return res.status(400).json({ error: 'Faltan campos' });
  const db = loadDB();
  if (db.clients.find(c => c.username?.toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: 'Usuario ya existe' });
  const { cuit, phone, precioKg } = req.body;
  const pk = parseFloat(precioKg);
  const newClient = { id: Date.now().toString(), name, email: email||'', phone: phone||'', cuit: cuit||'', username, password };
  if (Number.isFinite(pk) && pk > 0) newClient.precioKg = pk;
  db.clients.push(newClient);
  saveDB(db, 'admin-create-client');
  const { password: _pw, ...clientData } = newClient;
  res.status(201).json({ ok: true, client: clientData });
});

// Registrar pago para cualquier cliente
app.post('/api/admin/payments', requireAdmin, (req, res) => {
  const { clientId, monto, concepto, fecha, medio, nroComprobante } = req.body;
  if (!clientId || !monto) return res.status(400).json({ error: 'Datos inválidos' });
  const db  = loadDB();
  const ref = nroComprobante?.trim() || `TRF-${Math.floor(Math.random() * 9000 + 1000)}`;
  db.movements.push({
    fecha:    fecha || new Date().toISOString().split('T')[0],
    concepto: concepto || 'Pago cliente',
    ref,
    tipo: 'Pago',
    medio: medio || 'Transferencia',
    monto: -Math.abs(parseFloat(monto)),
    clientId,
  });
  saveDB(db, 'admin-payment');
  res.json({ ok: true, ref });
});

// Liquidación: actualizar costos y enviar email al cliente
// Arma el HTML del email de liquidación (reutilizado por crear y reenviar)
function buildLiquidacionEmailHtml(client, items, totalPeso, totalCosto) {
  const flag = { Miami: '🇺🇸', Madrid: '🇪🇸', China: '🇨🇳' };
  // Total global (suma manual): los ítems no tienen costo individual → mostramos "—" por fila.
  const itemsCostoSum = items.reduce((a, p) => a + Number(p.costo || 0), 0);
  const lumpSum = itemsCostoSum === 0 && totalCosto > 0;
  const rows = items.map(p => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${p.id}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${p.desc}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${flag[p.deposito]||''} ${p.deposito}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem;text-align:right">${Number(p.peso||0)} kg</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem;text-align:right;font-weight:700">${lumpSum ? '—' : 'USD ' + Number(p.costo||0).toFixed(2)}</td>
      </tr>`).join('');

  return `
    <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/></head>
    <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',sans-serif">
      <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
        <div style="background:#0a0a0a;padding:28px 32px">
          <div style="color:#fff;font-size:1.2rem;font-weight:800">Arbox Argentina</div>
          <div style="color:rgba(255,255,255,.5);font-size:.82rem;margin-top:4px">Liquidación de paquetes</div>
        </div>
        <div style="padding:32px">
          <p style="color:#555;font-size:.95rem">Hola <strong style="color:#0a0a0a">${client.name}</strong>,</p>
          <p style="color:#555;font-size:.9rem">Te enviamos el detalle de tu liquidación:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0">
            <thead><tr style="background:#f5f5f5">
              <th style="padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#888">Tracking</th>
              <th style="padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#888">Descripción</th>
              <th style="padding:10px 12px;text-align:left;font-size:.75rem;text-transform:uppercase;color:#888">Depósito</th>
              <th style="padding:10px 12px;text-align:right;font-size:.75rem;text-transform:uppercase;color:#888">Peso</th>
              <th style="padding:10px 12px;text-align:right;font-size:.75rem;text-transform:uppercase;color:#888">Costo</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr style="background:#0a0a0a">
              <td colspan="3" style="padding:12px;color:#fff;font-weight:800;font-size:.9rem">TOTAL</td>
              <td style="padding:12px;color:#fff;font-weight:700;text-align:right;font-size:.9rem">${totalPeso.toFixed(1)} kg</td>
              <td style="padding:12px;color:#fff;font-weight:800;text-align:right;font-size:1rem">USD ${totalCosto.toFixed(2)}</td>
            </tr></tfoot>
          </table>
          <p style="color:#555;font-size:.88rem;line-height:1.7">Para coordinar el pago, contactanos por WhatsApp o respondé a este email.</p>
        </div>
        <div style="background:#f5f5f5;padding:18px 32px;border-top:1px solid #eee">
          <p style="color:#aaa;font-size:.75rem;margin:0;text-align:center">Arbox Argentina — 10 años de trayectoria en Comercio Exterior</p>
        </div>
      </div>
    </body></html>`;
}

app.post('/api/admin/liquidacion', requireAdmin, async (req, res) => {
  const { clientId, packages: pkgUpdates, sendEmail, totalManual } = req.body;
  if (!clientId || !Array.isArray(pkgUpdates)) return res.status(400).json({ error: 'Datos inválidos' });

  const db = loadDB();
  const client = db.clients.find(c => c.id === clientId);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });

  let totalCosto = 0;
  let totalPeso  = 0;
  const items = [];

  pkgUpdates.forEach(u => {
    const pkg = db.packages.find(p => p.id === u.id && p.clientId === clientId);
    if (!pkg) return;
    if (u.peso !== undefined) pkg.peso = parseFloat(u.peso) || 0;
    if (u.costo !== undefined) pkg.costo = parseFloat(u.costo) || 0;
    totalCosto += pkg.costo;
    totalPeso  += pkg.peso;
    items.push(pkg);
  });

  // Total a cobrar: si se ingresó un total manual (> 0) prevalece sobre la suma por paquete.
  const manual = parseFloat(totalManual);
  const chargeTotal = (Number.isFinite(manual) && manual > 0) ? manual : totalCosto;

  // Token de entrega (QR) — los paquetes pasan a "Entregado" al escanearlo
  const ref = `LIQ-${Date.now().toString().slice(-6)}`;
  const deliveryToken = crypto.randomBytes(16).toString('hex');
  const itemsSnap = items.map(p => ({ id:p.id, desc:p.desc, deposito:p.deposito, peso:p.peso, costo:p.costo }));

  // Registrar cargo en cuenta corriente (con snapshot de ítems para el PDF)
  if (chargeTotal > 0) {
    db.movements.push({
      fecha:    new Date().toISOString().split('T')[0],
      concepto: 'Liquidación flete + almacenaje',
      ref,
      tipo:     'Cargo',
      monto:    chargeTotal,
      clientId,
      items:    itemsSnap,
      totalPeso,
      deliveryToken,
    });
  }
  db.deliveries = db.deliveries || {};
  db.deliveries[deliveryToken] = {
    clientId, ref, packageIds: items.map(p => p.id),
    delivered: false, deliveredAt: null, createdAt: Date.now(),
  };

  saveDB(db, 'admin-liquidacion');

  // Enviar email si se pidió
  if (sendEmail && client.email) {
    const html = buildLiquidacionEmailHtml(client, items, totalPeso, chargeTotal);

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'Arbox Argentina <noreply@arboxargentina.com>',
        to: client.email,
        subject: `Liquidación de paquetes — USD ${chargeTotal.toFixed(2)} — Arbox Argentina`,
        html,
      });
      console.log(`[email] Liquidación enviada a ${client.email} — USD ${chargeTotal.toFixed(2)}`);
    } catch (err) {
      console.error('[email] Error enviando liquidación:', err.message);
      return res.json({ ok: true, emailSent: false, totalCosto: chargeTotal, totalPeso, deliveryToken });
    }
  }

  res.json({ ok: true, emailSent: !!(sendEmail && client.email), totalCosto: chargeTotal, totalPeso, deliveryToken });
});

// Reenviar por email una liquidación ya existente (mismo documento: no crea cargo ni cambia estados)
app.post('/api/admin/liquidacion/:ref/resend', requireAdmin, async (req, res) => {
  const db = loadDB();
  const mov = db.movements.find(m => m.ref === req.params.ref && (m.ref || '').startsWith('LIQ-'));
  if (!mov) return res.status(404).json({ error: 'Liquidación no encontrada' });
  const client = db.clients.find(c => c.id === mov.clientId);
  if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
  if (!client.email) return res.json({ ok: true, emailSent: false, reason: 'sin-email' });

  // Detalle desde el snapshot guardado; fallback a los paquetes del token de entrega
  let items = Array.isArray(mov.items) ? mov.items : [];
  if (!items.length && mov.deliveryToken && (db.deliveries || {})[mov.deliveryToken]) {
    items = (db.deliveries[mov.deliveryToken].packageIds || [])
      .map(id => db.packages.find(p => p.id === id))
      .filter(Boolean)
      .map(p => ({ id: p.id, desc: p.desc, deposito: p.deposito, peso: p.peso, costo: p.costo }));
  }
  if (!items.length) return res.status(400).json({ error: 'La liquidación no tiene detalle para reenviar' });

  // El monto guardado del movimiento prevalece (respeta el total manual); si no, suma por ítem.
  const itemsCostoSum = items.reduce((a, p) => a + Number(p.costo || 0), 0);
  const totalCosto = Number(mov.monto) > 0 ? Number(mov.monto) : itemsCostoSum;
  const totalPeso  = items.reduce((a, p) => a + Number(p.peso || 0), 0);
  const html = buildLiquidacionEmailHtml(client, items, totalPeso, totalCosto);

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || 'Arbox Argentina <noreply@arboxargentina.com>',
      to: client.email,
      subject: `Liquidación de paquetes — USD ${totalCosto.toFixed(2)} — Arbox Argentina`,
      html,
    });
    console.log(`[email] Reenvío liquidación ${mov.ref} a ${client.email}`);
    return res.json({ ok: true, emailSent: true, to: client.email });
  } catch (err) {
    console.error('[email] Error reenviando liquidación:', err.message);
    return res.json({ ok: true, emailSent: false, reason: 'smtp-error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOK 17TRACK
// ═══════════════════════════════════════════════════════════════════════════════
//
//  Configurá esta URL en el portal de 17track:
//  POST  https://tudominio.com/api/webhook/17track
//
app.post('/api/webhook/17track', async (req, res) => {
  // 1. Verificar firma
  const signature = req.headers['sign'] || req.headers['x-17track-signature'] || '';
  if (!verifyWebhookSignature(req.body, signature)) {
    console.warn('[webhook] Firma inválida — ignorando petición');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // 2. Parsear payload
  let payload;
  try {
    payload = JSON.parse(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { event, data } = payload;
  console.log(`[webhook] Evento recibido: ${event} — tracking: ${data?.number}`);

  // Solo procesamos actualizaciones de estado
  if (event !== 'TRACKING_UPDATED') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const trackingNumber = data?.number;
  if (!trackingNumber) return res.status(200).json({ ok: true });

  // 3. Obtener info completa del paquete desde 17track
  const trackInfo = await getTrackInfo(trackingNumber);
  if (!trackInfo) {
    console.warn(`[webhook] No se pudo obtener info para ${trackingNumber}`);
    return res.status(200).json({ ok: true });
  }

  // 4. Buscar el paquete en nuestra base de datos
  const db  = loadDB();
  const pkg = db.packages.find(p => p.id === trackingNumber);
  if (!pkg) {
    console.log(`[webhook] Paquete ${trackingNumber} no encontrado en DB — ignorando`);
    return res.status(200).json({ ok: true });
  }

  // 5. Detectar si llegó al depósito de origen
  const arrival = detectDepotArrival(pkg, trackInfo);
  if (!arrival) {
    console.log(`[webhook] ${trackingNumber} — estado actualizado, pero no es llegada a depósito`);
    return res.status(200).json({ ok: true });
  }

  // 6. Actualizar estado del paquete
  pkg.estado = 'Recibido en origen';
  pkg.ultimoEvento = arrival.description;

  // 7. Enviar email si no fue notificado antes
  if (!pkg.notificado) {
    const client = db.clients.find(c => c.id === pkg.clientId);
    if (client?.email) {
      try {
        await sendArrivalEmail(client, pkg, arrival.description);
        pkg.notificado = true;
        console.log(`[webhook] ✓ Email enviado a ${client.email} para paquete ${trackingNumber}`);
      } catch (err) {
        console.error(`[webhook] Error enviando email:`, err.message);
        // No marcamos como notificado para reintentar
      }
    } else {
      console.warn(`[webhook] Cliente sin email para paquete ${trackingNumber}`);
    }
  }

  saveDB(db, 'webhook-17track');
  // Siempre responder 200 para que 17track no reintente
  res.status(200).json({ ok: true });
});

// ─── Reporte diario de paquetes nuevos ───────────────────────────────────────
async function sendDailyReport(dateOverride) {
  const db   = loadDB();
  const today = dateOverride || new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });

  const newPkgs = db.packages.filter(p => p.fecha === today);
  console.log(`[daily] Paquetes del ${today}: ${newPkgs.length}`);

  if (!newPkgs.length) {
    console.log('[daily] Sin paquetes nuevos — no se envía reporte');
    return { sent: false, count: 0 };
  }

  const rows = newPkgs.map(p => {
    const client = db.clients.find(c => c.id === p.clientId);
    const flag = { Miami: '🇺🇸', Madrid: '🇪🇸', China: '🇨🇳' }[p.deposito] || '';
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem;font-weight:700;color:#0a0a0a">${p.id}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${client?.name || '—'}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${flag} ${p.deposito}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${p.desc}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem">${p.peso} kg</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-size:.85rem;color:#555">${p.estado}</td>
      </tr>`;
  }).join('');

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',sans-serif">
  <div style="max-width:700px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e5e5">
    <div style="background:#0a0a0a;padding:28px 32px">
      <div style="color:#fff;font-size:1.2rem;font-weight:800;letter-spacing:-.02em">Arbox Argentina</div>
      <div style="color:rgba(255,255,255,.5);font-size:.82rem;margin-top:4px">Resumen diario — ${today}</div>
    </div>
    <div style="padding:32px">
      <p style="color:#555;font-size:.95rem;margin-bottom:20px">
        Se registraron <strong style="color:#0a0a0a">${newPkgs.length} paquete(s)</strong> el día de hoy.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:10px 12px;text-align:left;font-size:.72rem;text-transform:uppercase;color:#888">Tracking</th>
            <th style="padding:10px 12px;text-align:left;font-size:.72rem;text-transform:uppercase;color:#888">Cliente</th>
            <th style="padding:10px 12px;text-align:left;font-size:.72rem;text-transform:uppercase;color:#888">Depósito</th>
            <th style="padding:10px 12px;text-align:left;font-size:.72rem;text-transform:uppercase;color:#888">Descripción</th>
            <th style="padding:10px 12px;text-align:left;font-size:.72rem;text-transform:uppercase;color:#888">Peso</th>
            <th style="padding:10px 12px;text-align:left;font-size:.72rem;text-transform:uppercase;color:#888">Estado</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="background:#f5f5f5;padding:18px 32px;border-top:1px solid #eee">
      <p style="color:#aaa;font-size:.75rem;margin:0;text-align:center">
        Arbox Argentina — Reporte automático diario
      </p>
    </div>
  </div>
</body>
</html>`;

  let sent = 0;
  for (const admin of SUPERADMINS) {
    if (!admin.email) continue;
    try {
      await transporter.sendMail({
        from:    process.env.EMAIL_FROM || 'Arbox Argentina <noreply@arboxargentina.com>',
        to:      admin.email,
        subject: `📦 Resumen diario ${today} — ${newPkgs.length} paquete(s) nuevos`,
        html,
      });
      console.log(`[daily] Reporte enviado a ${admin.email}`);
      sent++;
    } catch (err) {
      console.error(`[daily] Error enviando a ${admin.email}:`, err.message);
    }
  }
  return { sent, count: newPkgs.length };
}

// Scheduler: revisa cada minuto si es la hora de enviar el reporte diario
// Hora configurable por env DAILY_REPORT_HOUR (0-23, ART). Default: 21
const DAILY_REPORT_HOUR = parseInt(process.env.DAILY_REPORT_HOUR || '21');
let lastDailyReportDate = null;

setInterval(() => {
  const nowART = new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  const [dateStr, timeStr] = nowART.split(' ');
  const hour = parseInt(timeStr.split(':')[0]);
  if (hour === DAILY_REPORT_HOUR && lastDailyReportDate !== dateStr) {
    lastDailyReportDate = dateStr;
    console.log(`[daily] Disparando reporte diario del ${dateStr}...`);
    sendDailyReport().catch(err => console.error('[daily] Error:', err.message));
  }
}, 60_000);

// ─── Endpoint admin: disparo manual del reporte diario ────────────────────────
// POST /api/admin/daily-report  { "date": "2026-05-04" }  (date opcional)

// ─── Diagnóstico general ──────────────────────────────────────────────────────
app.get('/api/diag', (req, res) => {
  const db = loadDB();
  const nowART = new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  const [todayStr, timeStr] = nowART.split(' ');
  const pkgsHoy = db.packages.filter(p => p.fecha === todayStr);
  res.json({
    ok: true,
    clients: db.clients.length,
    packages: db.packages.length,
    movements: db.movements.length,
    packageIds: db.packages.map(p => p.id),
    dbFile: DB_FILE,
    exists: fs.existsSync(DB_FILE),
    smtp: { host: process.env.SMTP_HOST, user: process.env.SMTP_USER, configured: !!process.env.SMTP_PASS },
    track17: { configured: !!process.env.TRACK17_API_KEY },
    dailyReport: {
      scheduledHour: DAILY_REPORT_HOUR,
      lastSent: lastDailyReportDate,
      serverTimeART: nowART,
      pkgsHoy: pkgsHoy.length,
    },
  });
});

// ─── Diagnóstico 17track por paquete (admin) ──────────────────────────────────
// Devuelve lo que 17track conoce sobre un tracking, con la detección aplicada.
app.get('/api/admin/diag17track/:id', requireAdmin, async (req, res) => {
  const trackingNumber = req.params.id;
  const db  = loadDB();
  const pkg = db.packages.find(p => p.id === trackingNumber);

  const trackInfo = await getTrackInfo(trackingNumber);
  if (!trackInfo) {
    return res.json({ ok: false, error: '17track no devolvió datos para este tracking', pkg: pkg || null });
  }

  const events  = extractAllEvents(trackInfo);
  const arrival = pkg ? detectDepotArrival(pkg, trackInfo) : false;

  const ti = trackInfo.track_info || {};
  res.json({
    ok:           true,
    pkg:          pkg || null,
    arrival,
    latestStatus: ti.latest_status,
    latestEvent:  ti.latest_event,
    events:       events.map(e => ({
      stage:       e.stage,
      description: e.description,
      location:    e.location,
      time:        e.time_iso || e.time_utc,
      address:     e.address,
    })),
    raw17track: ti,
  });
});

// ─── Sincronización manual 17track (admin) ────────────────────────────────────
app.post('/api/admin/sync17track', requireAdmin, async (req, res) => {
  try {
    const result = await syncPackagesWith17track();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[sync17] Error en sync manual:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Reporte diario manual (admin) ───────────────────────────────────────────
app.post('/api/admin/daily-report', requireAdmin, async (req, res) => {
  const { date } = req.body;
  try {
    const result = await sendDailyReport(date || undefined);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[daily] Error en disparo manual:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Test SMTP (admin) ───────────────────────────────────────────────────────
app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  const { to } = req.body;
  const recipient = to || SUPERADMINS[0]?.email;
  if (!recipient) return res.status(400).json({ error: 'Sin destinatario' });
  try {
    await transporter.sendMail({
      from:    process.env.EMAIL_FROM || 'Arbox Argentina <noreply@arboxargentina.com>',
      to:      recipient,
      subject: `✅ Test SMTP — Arbox Argentina ${new Date().toISOString()}`,
      text:    'Si recibiste este email, el SMTP está configurado correctamente.',
    });
    console.log(`[test-email] Email de prueba enviado a ${recipient}`);
    res.json({ ok: true, to: recipient });
  } catch (err) {
    console.error('[test-email] Error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Meta Conversions API (server-side) ───────────────────────────────────────
// Recibe eventos del sitio y los reenvía a Meta. Se deduplica con el pixel del
// navegador vía event_id. INERTE si META_CAPI_TOKEN no está configurado en .env.
app.post('/api/track', async (req, res) => {
  try {
    const PIXEL_ID = process.env.META_PIXEL_ID || '943206914715277';
    const TOKEN    = process.env.META_CAPI_TOKEN || '';
    if (!TOKEN) return res.json({ ok: true, skipped: 'no_token' });

    const b   = req.body || {};
    const ud  = b.user_data || {};
    const sha = (v) => v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : undefined;
    const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';

    const user_data = { client_ip_address: ip, client_user_agent: req.headers['user-agent'] || '' };
    if (ud.fbp) user_data.fbp = ud.fbp;
    if (ud.fbc) user_data.fbc = ud.fbc;
    if (ud.em)  user_data.em  = [sha(ud.em)];
    if (ud.ph)  user_data.ph  = [sha(String(ud.ph).replace(/\D/g, ''))];

    const event = {
      event_name:       b.event_name || 'Lead',
      event_time:       Math.floor(Date.now() / 1000),
      event_id:         b.event_id || undefined,
      event_source_url: b.event_source_url || '',
      action_source:    'website',
      user_data,
      custom_data:      b.custom_data || {},
    };

    const url  = `https://graph.facebook.com/v19.0/${PIXEL_ID}/events?access_token=${encodeURIComponent(TOKEN)}`;
    const resp = await axios.post(url, { data: [event] }, { timeout: 8000 });
    res.json({ ok: true, events_received: resp.data && resp.data.events_received });
  } catch (err) {
    console.error('[capi] Error:', err.response && err.response.data ? JSON.stringify(err.response.data) : err.message);
    res.json({ ok: false, error: 'capi_failed' }); // nunca rompemos el front
  }
});

// ─── Confirmación de entrega por QR (público, sin login) ─────────────────────
app.get('/api/entrega/:token', (req, res) => {
  const db = loadDB();
  const d = (db.deliveries || {})[req.params.token];
  if (!d) return res.status(404).json({ error: 'Entrega no encontrada' });
  const client = db.clients.find(c => c.id === d.clientId);
  const pkgs = d.packageIds.map(id => {
    const p = db.packages.find(x => x.id === id);
    return p ? { id: p.id, desc: p.desc, estado: p.estado } : { id, desc: '', estado: '' };
  });
  res.json({ ref: d.ref, cliente: client?.name || '', delivered: d.delivered, deliveredAt: d.deliveredAt, packages: pkgs });
});

app.post('/api/entrega/:token', (req, res) => {
  const db = loadDB();
  const d = (db.deliveries || {})[req.params.token];
  if (!d) return res.status(404).json({ error: 'Entrega no encontrada' });
  if (d.delivered) return res.json({ ok: true, already: true, deliveredAt: d.deliveredAt });
  const hoy = new Date().toISOString().split('T')[0];
  d.packageIds.forEach(id => {
    const p = db.packages.find(x => x.id === id);
    if (p && p.estado !== 'Entregado') {
      p.estado = 'Entregado';
      if (!p.historial) p.historial = [];
      p.historial.push({ estado: 'Entregado', fecha: hoy, ts: Date.now() });
    }
  });
  d.delivered = true; d.deliveredAt = Date.now();
  saveDB(db, 'entrega-qr');
  res.json({ ok: true, deliveredAt: d.deliveredAt });
});

// Página pública que abre el repartidor al escanear el QR
app.get('/entrega/:token', (req, res) => {
  const token = req.params.token.replace(/[^a-f0-9]/gi, '');
  res.type('html').send(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Confirmar entrega — Arbox</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f5;margin:0;padding:20px;color:#1a1a1a}.card{max-width:440px;margin:24px auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:1.2rem;margin:0 0 4px}.muted{color:#888;font-size:.85rem}.pkg{padding:10px 0;border-bottom:1px solid #eee;font-size:.9rem}.btn{display:block;width:100%;padding:14px;border:none;border-radius:10px;background:#1a1a1a;color:#fff;font-size:1rem;font-weight:700;cursor:pointer;margin-top:16px}.btn:disabled{opacity:.5}.ok{background:#e8f5e9;color:#2e7d32;padding:14px;border-radius:10px;text-align:center;font-weight:700;margin-top:16px}</style></head>
<body><div class="card"><h1>Confirmar entrega</h1><div class="muted" id="ref">—</div><div id="list" style="margin-top:14px"></div><div id="action"></div></div>
<script>
var token=${JSON.stringify(token)};
function load(){fetch('/api/entrega/'+token).then(function(r){return r.json();}).then(function(d){
  if(d.error){document.querySelector('.card').innerHTML='<h1>Entrega no encontrada</h1><div class="muted">El c\\u00f3digo no es v\\u00e1lido.</div>';return;}
  document.getElementById('ref').textContent='Cliente: '+(d.cliente||'\\u2014')+'  \\u00b7  '+d.ref;
  document.getElementById('list').innerHTML=d.packages.map(function(p){return '<div class="pkg"><strong>'+p.id+'</strong><br><span class="muted">'+(p.desc||'')+' \\u2014 '+p.estado+'</span></div>';}).join('');
  var a=document.getElementById('action');
  if(d.delivered){a.innerHTML='<div class="ok">\\u2713 Ya entregado</div>';}
  else{a.innerHTML='<button class="btn" id="b" onclick="confirmar()">\\u2705 Confirmar entrega</button>';}
}).catch(function(){document.querySelector('.card').innerHTML='<h1>Error</h1><div class="muted">Prob\\u00e1 de nuevo.</div>';});}
function confirmar(){var b=document.getElementById('b');b.disabled=true;b.textContent='Confirmando...';
  fetch('/api/entrega/'+token,{method:'POST'}).then(function(r){return r.json();}).then(function(){document.getElementById('action').innerHTML='<div class="ok">\\u2713 \\u00a1Entrega confirmada!</div>';}).catch(function(){b.disabled=false;b.textContent='\\u2705 Confirmar entrega';});}
load();
</script></body></html>`);
});

// ─── Ruta raíz → index.html ───────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Página de invitación → index.html (la vista de alta la maneja el front) ──
app.get('/invitacion/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Iniciar servidor ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║          Arbox Argentina — Servidor iniciado         ║
╠══════════════════════════════════════════════════╣
║  URL local:   http://localhost:${PORT}              ║
║  Webhook:     http://localhost:${PORT}/api/webhook/17track  ║
╠══════════════════════════════════════════════════╣
║  Para exponer el webhook al exterior usá ngrok:  ║
║  ngrok http ${PORT}                                 ║
╚══════════════════════════════════════════════════╝
  `);

  if (!process.env.TRACK17_API_KEY) console.warn('⚠ TRACK17_API_KEY no configurada en .env');
  if (!process.env.SMTP_USER)       console.warn('⚠ SMTP_USER no configurado en .env');

  // Polling activo: configurable via POLL_INTERVAL_MIN, default 30 minutos
  const POLL_INTERVAL = (parseInt(process.env.POLL_INTERVAL_MIN) || 30) * 60 * 1000;
  console.log(`[sync17] Polling cada ${POLL_INTERVAL / 60000} minutos`);
  setInterval(() => {
    console.log('[sync17] Iniciando sincronización periódica...');
    syncPackagesWith17track().catch(err => console.error('[sync17] Error periódico:', err.message));
  }, POLL_INTERVAL);

  // Primera sincronización 30 segundos después del arranque
  if (process.env.TRACK17_API_KEY) {
    setTimeout(() => {
      console.log('[sync17] Sincronización inicial al arranque...');
      syncPackagesWith17track().catch(err => console.error('[sync17] Error inicial:', err.message));
    }, 30_000);
  }
});
