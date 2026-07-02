# Procesar Manifiesto — Fase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un botón en el panel admin que, al subir manifiestos en PDF, consolida por cliente (PDF+Excel), pasa a "En tránsito" los paquetes existentes (match por sufijo) y auto-crea los faltantes — todo con vista previa y confirmación.

**Architecture:** Lógica pura de parseo/matcheo/consolidación en un archivo compartido `manifest-core.js` (usable en navegador y en Node para tests). El PDF se lee con pdf.js (CDN) y el Excel se genera con SheetJS (CDN); el PDF de salida con el enfoque de impresión ya usado. El backend agrega un solo endpoint idempotente para crear los faltantes sin mandar email; el resto reusa endpoints existentes.

**Tech Stack:** JS vanilla (navegador), Node/Express (`server.js`), pdf.js (`pdfjs-dist`), SheetJS (`xlsx`), sin framework de tests (harness de Node + verificación por arranque/curl, patrón del repo).

**Spec:** `docs/superpowers/specs/2026-07-02-procesar-manifiesto-fase1-design.md`

---

## File Structure

- **Create** `manifest-core.js` (raíz): lógica pura y compartida — `reconstructLines`, `parseRecords`, `ALIAS`, `canonicalize`, `groupByClient`, `matchBySuffix`, `planIngest`. Sin dependencias de DOM/pdf.js (recibe texto/estructuras ya extraídas). Exporta a `window.ManifestCore` (navegador) y `module.exports` (Node).
- **Modify** `index.html`: cargar pdf.js/SheetJS/`manifest-core.js`; nueva sección admin "Procesar manifiesto" (nav + panel + modal de preview); glue UI (upload → extraer texto con pdf.js → usar ManifestCore → preview → confirmar → llamar endpoints → generar PDF/Excel).
- **Modify** `server.js`: nuevo endpoint `POST /api/admin/packages/ingest` (crea faltantes, idempotente, sin email).
- **Modify** `deploy.sh`: agregar `manifest-core.js` a la lista de archivos.
- **Test harness (scratchpad, no se despliega):** `test/` con `run-parser.mjs`, `run-match.mjs`, y fixtures (`fixture-db.json` sintético). Usa los 2 PDF reales ya presentes en la raíz (`ALAN MANIFIESTOS Y PAGOS 19.6.pdf`, `22.6.pdf`).

Convención de verificación del repo (sin framework de tests): `node --check` para sintaxis de `server.js`/`manifest-core.js`; compilación de los `<script>` inline de `index.html` con `vm`; arranque local del server + `curl`; y harness de Node para la lógica pura.

---

### Task 1: `manifest-core.js` — reconstrucción de líneas + parseo de registros

**Files:**
- Create: `manifest-core.js`
- Test: `<scratchpad>/test/run-parser.mjs`

- [ ] **Step 1: Crear `manifest-core.js` con `reconstructLines` y `parseRecords`**

```js
// manifest-core.js — lógica pura compartida (navegador + Node). Sin DOM ni pdf.js.
(function (root) {
  'use strict';

  // --- Reconstrucción de líneas a partir de items de texto de pdf.js ---
  // items: [{ str, x, y, w, h }]  (x=transform[4], y=transform[5], w=width, h=alto de fuente)
  // Los manifiestos están maquetados en VARIAS COLUMNAS por página. pdf.js entrega los
  // items en orden de lectura (columna por columna). Recorremos EN ESE ORDEN y cortamos
  // línea al cambiar la Y (>3). Ordenar por geometría mezclaría columnas distintas.
  function reconstructLines(items) {
    function build(group) {
      const its = group.slice().sort((a, b) => a.x - b.x);
      let line = '', prev = null;
      for (const it of its) {
        if (prev) {
          const gap = it.x - (prev.x + (prev.w || 0));
          const spaceW = 0.25 * (it.h || 8);
          line += gap > spaceW ? ' ' : '';
        }
        line += it.str;
        prev = it;
      }
      return line.replace(/\s+/g, ' ').trim();
    }
    const lines = [];
    let cur = [], curY = null;
    for (const it of items) {
      if (!it.str) continue;
      if (curY !== null && Math.abs(it.y - curY) > 3) {
        const l = build(cur); if (l) lines.push(l);
        cur = [];
      }
      cur.push(it);
      curY = it.y;
    }
    const last = build(cur); if (last) lines.push(last);
    return lines;
  }

  // --- Parseo de registros a partir de líneas de texto ---
  const NOISE = ['CAJ', 'KGS', 'ALAN', 'TOTAL', 'Cliente', 'rastreo', 'Kilos', 'de', 'Nº'];
  const CLIENT_NOISE = new Set(['PCS', 'PC', 'GB']);
  const isInt = t => /^\d+$/.test(t);
  const isKilos = t => /^\d+\.\d+$/.test(t);
  const isAlpha = t => /^[A-ZÑ]+$/.test(t) && !CLIENT_NOISE.has(t);
  const isHeader = line => NOISE.some(k => line.includes(k));

  function parseRecords(lines, manifest) {
    const recs = [];
    let lastClient = null;
    for (const raw of lines) {
      const line = (raw || '').trim();
      if (!line) continue;
      const header = isHeader(line);
      const toks = line.split(/\s+/);
      const hasK = toks.some(isKilos);
      if (hasK && !header) {
        const idx = toks.findIndex(isKilos);
        const kilos = parseFloat(toks[idx]);
        let prefix = toks.slice(0, idx);
        if (prefix.length >= 2 && isInt(prefix[0]) && isAlpha(prefix[1])) prefix = prefix.slice(1);
        let ci = 0;
        while (ci < prefix.length && isAlpha(prefix[ci])) ci++;
        const inline = prefix.slice(0, ci).join(' ');
        const tracking = prefix.slice(ci).join(' ').trim();
        const client = inline || (lastClient || '');
        recs.push({ manifest, client_raw: client, tracking, kilos });
        continue;
      }
      if (!header) {
        const m = line.match(/^(?:\d+\s+)?([A-ZÑ][A-ZÑ ]*[A-ZÑ]|[A-ZÑ]+)$/);
        if (m) {
          const words = m[1].split(/\s+/).filter(w => !CLIENT_NOISE.has(w));
          if (words.length) lastClient = words.join(' ');
        }
      }
    }
    return recs;
  }

  const api = { reconstructLines, parseRecords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ManifestCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: Crear el harness de parseo en scratchpad**

Crear `<scratchpad>/test/run-parser.mjs` (usa el `pdfjs-dist` ya instalado en scratchpad y los 2 PDF reales de la raíz):

```js
import * as pdfjs from '../node_modules/pdfjs-dist/legacy/build/pdf.mjs';
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const MC = require('/Users/alancherula/Documents/Claude/arboxargentina/manifest-core.js');

async function itemsOf(path) {
  const data = new Uint8Array(fs.readFileSync(path));
  const doc = await pdfjs.getDocument({ data }).promise;
  let items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    items = items.concat(tc.items.map(it => ({
      str: it.str, x: it.transform[4], y: it.transform[5],
      w: it.width, h: Math.hypot(it.transform[2], it.transform[3]) || it.height || 8,
    })));
  }
  return items;
}

const base = '/Users/alancherula/Documents/Claude/arboxargentina/';
let all = [];
for (const [f, m] of [['ALAN MANIFIESTOS Y PAGOS 19.6.pdf', '19.6'], ['22.6.pdf', '22.6']]) {
  const lines = MC.reconstructLines(await itemsOf(base + f));
  all = all.concat(MC.parseRecords(lines, m));
}
const total = all.reduce((a, r) => a + r.kilos, 0);
console.log('paquetes:', all.length, '| kg:', total.toFixed(2));
const okCount = all.length === 213;
const okKg = Math.abs(total - 704.28) < 0.01;
console.log(okCount && okKg ? 'PASS' : 'FAIL');
process.exit(okCount && okKg ? 0 : 1);
```

- [ ] **Step 3: Correr el harness — debe fallar si el parser está incompleto, luego pasar**

Run: `cd <scratchpad> && node test/run-parser.mjs 2>/dev/null`
Expected: `paquetes: 213 | kg: 704.28` y `PASS`

- [ ] **Step 4: `node --check` del core**

Run: `node --check /Users/alancherula/Documents/Claude/arboxargentina/manifest-core.js`
Expected: sin salida (OK)

- [ ] **Step 5: Commit**

```bash
git add manifest-core.js
git commit -m "feat(manifiesto) core: reconstrucción de líneas y parseo de registros"
```

---

### Task 2: `manifest-core.js` — alias, canonicalización y agrupación

**Files:**
- Modify: `manifest-core.js`
- Test: `<scratchpad>/test/run-parser.mjs` (extender)

- [ ] **Step 1: Agregar `ALIAS`, `canonicalize`, `groupByClient` al core**

Insertar dentro del IIFE, antes de `const api = ...`:

```js
  // --- Alias (negocio + artefactos de extracción del 22.6) ---
  // Incluye alias de negocio y artefactos de extracción de pdf.js (letter-spacing del 22.6).
  const ALIAS = {
    'VALERIA CALDERON': 'CALDERONE', 'VALERIA CALDERO N': 'CALDERONE',
    'CALDERO NE': 'CALDERONE', 'CALDERONE': 'CALDERONE',
    'SCONF': 'SCONFIETTI', 'SCO NF': 'SCONFIETTI', 'SCO NFIETTI': 'SCONFIETTI', 'SCONFIETTI': 'SCONFIETTI',
    'MIGUES': 'MIGUEZ', 'MIGUEZ': 'MIGUEZ',
    'CACOPARDO': 'CALOPARDO', 'CACO PARDO': 'CALOPARDO',
    'MONICA CACOPAR': 'CALOPARDO', 'MO NICA CACO PAR': 'CALOPARDO', 'CALOPARDO': 'CALOPARDO',
    'ELI': 'ELIANA', 'ELIANA': 'ELIANA',
    'ACO STA': 'ACOSTA', 'ACOSTA': 'ACOSTA', 'CO RTEZ': 'CORTEZ', 'CORTEZ': 'CORTEZ',
    'GREGO RIC': 'GREGORIC', 'TEO DELINA': 'TEODELINA',
    'AMALGAM': 'AMALGAM/MALDONADO/MENCONI', 'MALDONADO': 'AMALGAM/MALDONADO/MENCONI',
    'DANIEL MALDONADO': 'AMALGAM/MALDONADO/MENCONI', 'DANIELMALDONAD': 'AMALGAM/MALDONADO/MENCONI',
    'DANIEL MALDO NAD': 'AMALGAM/MALDONADO/MENCONI', 'MENCONI': 'AMALGAM/MALDONADO/MENCONI',
  };

  function canonicalize(name, extra) {
    const map = Object.assign({}, ALIAS, extra || {});
    const key = (name || '').trim().toUpperCase();
    return map[key] || (name || '').trim();
  }

  function groupByClient(recs, extraAlias) {
    const groups = {};
    for (const r of recs) {
      const c = canonicalize(r.client_raw, extraAlias);
      (groups[c] = groups[c] || []).push(Object.assign({ client: c }, r));
    }
    return groups;
  }
```

Y agregar a `api`: `const api = { reconstructLines, parseRecords, ALIAS, canonicalize, groupByClient };`

- [ ] **Step 2: Extender el harness para verificar agrupación**

Añadir al final de `run-parser.mjs` (antes del `process.exit`):

```js
const groups = MC.groupByClient(all);
const sconf = (groups['SCONFIETTI'] || []).length;   // SCONF + SCONFIETTI unidos
const cald = (groups['CALDERONE'] || []).length;      // CALDERONE + VALERIA CALDERON
console.log('SCONFIETTI:', sconf, '| CALDERONE:', cald, '| grupos:', Object.keys(groups).length);
const okGroups = sconf === 45 && cald === 10;
if (!(okCount && okKg && okGroups)) process.exit(1);
```

(Y cambiar el `process.exit` final para contemplar `okGroups`.)

- [ ] **Step 3: Correr el harness**

Run: `cd <scratchpad> && node test/run-parser.mjs 2>/dev/null`
Expected: `SCONFIETTI: 45 | CALDERONE: 10 | grupos: 26` y `PASS`

- [ ] **Step 4: `node --check` + commit**

```bash
node --check /Users/alancherula/Documents/Claude/arboxargentina/manifest-core.js
git add manifest-core.js
git commit -m "feat(manifiesto) core: alias, canonicalización y agrupación por cliente"
```

---

### Task 3: `manifest-core.js` — matcheo por sufijo y plan de ingesta

**Files:**
- Modify: `manifest-core.js`
- Test: `<scratchpad>/test/run-match.mjs`, `<scratchpad>/test/fixture-db.json`

- [ ] **Step 1: Agregar `matchBySuffix` y `planIngest` al core**

```js
  const norm = s => String(s == null ? '' : s).toUpperCase().replace(/\s/g, '');
  const ADVANCED = new Set(['En tránsito', 'En viaje', 'Clasificando en BsAs', 'Listo para entrega', 'Entregado', 'Retenido']);

  // packages: [{ id, clientId, estado }]. Devuelve {status:'exact'|'suffix'|'ambiguous'|'none', matches:[pkg]}
  function matchBySuffix(tracking, packages) {
    const T = norm(tracking);
    if (!T) return { status: 'none', matches: [] };
    const exact = packages.filter(p => norm(p.id) === T);
    if (exact.length === 1) return { status: 'exact', matches: exact };
    const suf = packages.filter(p => norm(p.id).endsWith(T));
    if (suf.length === 1) return { status: 'suffix', matches: suf };
    if (suf.length > 1) return { status: 'ambiguous', matches: suf };
    return { status: 'none', matches: [] };
  }

  // Busca cliente por apellido canónico como token completo del nombre. clients:[{id,name}]
  function findClientsByName(canonName, clients) {
    const parts = canonName.split('/');   // p.ej. AMALGAM/MALDONADO/MENCONI
    const hit = [];
    for (const c of clients) {
      const toks = String(c.name || '').toUpperCase().split(/\s+/);
      if (parts.some(p => toks.includes(p.toUpperCase()))) hit.push(c);
    }
    return hit;
  }

  // recs: registros parseados (con client canónico opcional). packages/clients de la base.
  // Devuelve categorías para la preview.
  function planIngest(recs, packages, clients, extraAlias) {
    const plan = { transit: [], skip: [], ambiguous: [], createAssigned: [], createUnassigned: [], noTracking: [] };
    for (const r of recs) {
      const canon = canonicalize(r.client_raw, extraAlias);
      if (!r.tracking || /PCS/i.test(r.tracking)) { plan.noTracking.push({ ...r, client: canon }); continue; }
      const m = matchBySuffix(r.tracking, packages);
      if (m.status === 'ambiguous') { plan.ambiguous.push({ ...r, client: canon, matches: m.matches }); continue; }
      if (m.status === 'exact' || m.status === 'suffix') {
        const pkg = m.matches[0];
        if (ADVANCED.has(pkg.estado)) plan.skip.push({ ...r, client: canon, pkg });
        else plan.transit.push({ ...r, client: canon, pkg });
        continue;
      }
      const cli = findClientsByName(canon, clients);
      if (cli.length === 1) plan.createAssigned.push({ ...r, client: canon, clientId: cli[0].id });
      else plan.createUnassigned.push({ ...r, client: canon, clientId: null });
    }
    return plan;
  }
```

Agregar a `api`: `matchBySuffix, findClientsByName, planIngest`.

- [ ] **Step 2: Crear fixture sintético (sin datos reales de clientes)**

`<scratchpad>/test/fixture-db.json`:

```json
{
  "clients": [
    { "id": "c1", "name": "Valeria Calderone" },
    { "id": "c2", "name": "Emiliano Bernal" },
    { "id": "c3", "name": "Matias Bernal" }
  ],
  "packages": [
    { "id": "DA72BA28F8C100E90", "clientId": "c1", "estado": "Recibido en origen" },
    { "id": "1Z24WA43YW28738661", "clientId": "c1", "estado": "Entregado" },
    { "id": "AAA111", "clientId": "c1", "estado": "Registrado" },
    { "id": "BBB111", "clientId": "c1", "estado": "Registrado" }
  ]
}
```

- [ ] **Step 3: Crear el harness de matcheo**

`<scratchpad>/test/run-match.mjs`:

```js
import fs from 'fs';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const MC = require('/Users/alancherula/Documents/Claude/arboxargentina/manifest-core.js');
const db = JSON.parse(fs.readFileSync(new URL('./fixture-db.json', import.meta.url)));

const recs = [
  { client_raw: 'CALDERONE', tracking: '100E90', kilos: 1.2 },   // suffix -> Recibido => transit
  { client_raw: 'CALDERONE', tracking: '738661', kilos: 1.9 },   // suffix -> Entregado => skip
  { client_raw: 'CALDERONE', tracking: '111', kilos: 0.5 },      // AAA111 y BBB111 terminan en 111 => ambiguous
  { client_raw: 'CALDERONE', tracking: '777777', kilos: 1.0 },   // sin match, 1 cliente (Valeria Calderone) => createAssigned
  { client_raw: 'REGALINI',  tracking: '999999', kilos: 2.0 },   // sin match, 0 clientes => createUnassigned
  { client_raw: 'BERNAL',    tracking: '888888', kilos: 2.0 },   // sin match, 2 clientes (Bernal) => createUnassigned
  { client_raw: 'HENAO',     tracking: '',       kilos: 3.0 },   // sin tracking => noTracking
];
const plan = MC.planIngest(recs, db.packages, db.clients);
const r = {
  transit: plan.transit.length, skip: plan.skip.length, ambiguous: plan.ambiguous.length,
  createAssigned: plan.createAssigned.length, createUnassigned: plan.createUnassigned.length,
  noTracking: plan.noTracking.length,
};
console.log(JSON.stringify(r));
const ok = r.transit === 1 && r.skip === 1 && r.ambiguous === 1 &&
           r.createAssigned === 1 && r.createUnassigned === 2 && r.noTracking === 1;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
```

- [ ] **Step 4: Correr el harness**

Run: `cd <scratchpad> && node test/run-match.mjs`
Expected: `{"transit":1,"skip":1,"ambiguous":1,"createAssigned":1,"createUnassigned":2,"noTracking":1}` y `PASS`

- [ ] **Step 5: `node --check` + commit**

```bash
node --check /Users/alancherula/Documents/Claude/arboxargentina/manifest-core.js
git add manifest-core.js
git commit -m "feat(manifiesto) core: matcheo por sufijo y plan de ingesta"
```

---

### Task 4: Backend — endpoint `POST /api/admin/packages/ingest`

**Files:**
- Modify: `server.js` (agregar el endpoint junto a los otros `/api/admin/packages/*`, después del bloque `bulk` ~línea 1264)
- Test: arranque local + login + curl

- [ ] **Step 1: Agregar el endpoint en `server.js`**

Insertar después del handler `app.put('/api/admin/packages/bulk', …)` (termina ~línea 1264):

```js
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
      destinatario: '', deposito: it.deposito || 'Miami',
      desc: it.desc || 'Paquete en tránsito (manifiesto)',
      peso: parseFloat(it.peso) || 0, valor: 0, costo: 0, remitente: '', obs: '',
      estado, fecha: hoy, pagado: false, notificado: false, documents: null,
      historial: [{ estado, fecha: hoy, ts: Date.now() }],
    });
    creados++;
  }
  saveDB(db, 'manifiesto-ingest');
  res.status(201).json({ ok: true, creados, omitidos });
});
```

- [ ] **Step 2: `node --check`**

Run: `node --check server.js`
Expected: sin salida (OK)

- [ ] **Step 3: Arrancar server local y verificar que la ruta está protegida**

Run:
```bash
(PORT=3999 node server.js >/tmp/boot.log 2>&1 & echo $! >/tmp/boot.pid); sleep 3
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3999/api/admin/packages/ingest
```
Expected: `403` (ruta registrada, protegida)

- [ ] **Step 4: Test de integración autenticado (login → ingest → verificar)**

Run (usa credenciales SUPERADMIN de `.env`):
```bash
source .env
TOKEN=$(curl -s -X POST http://localhost:3999/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"$ADMIN_1_USERNAME\",\"password\":\"$ADMIN_1_PASSWORD\"}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).adminToken))")
echo "token: ${TOKEN:0:8}..."
curl -s -X POST http://localhost:3999/api/admin/packages/ingest -H "x-admin-token: $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"id":"TESTMANIF001","peso":1.5,"estado":"En tránsito"},{"id":"TESTMANIF001","peso":1.5}]}'
```
Expected: `{"ok":true,"creados":1,"omitidos":1}` (segundo item duplicado → omitido)

- [ ] **Step 5: Limpiar el paquete de prueba de la DB local y matar el server**

Run:
```bash
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('db.json','utf8'));d.packages=d.packages.filter(p=>p.id!=='TESTMANIF001');fs.writeFileSync('db.json',JSON.stringify(d,null,2))"
kill "$(cat /tmp/boot.pid)" 2>/dev/null
```
Expected: sin errores; `db.json` local sin `TESTMANIF001`.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(manifiesto) endpoint /api/admin/packages/ingest (alta batch sin email)"
```

---

### Task 5: `index.html` — cargar libs (pdf.js, SheetJS, manifest-core) + deploy.sh

**Files:**
- Modify: `index.html` (junto a `loadQRLib`, ~línea 857)
- Modify: `deploy.sh` (lista `FILES`)

- [ ] **Step 1: Agregar loaders de pdf.js y SheetJS (patrón `loadQRLib`)**

Junto a `loadQRLib` en `index.html`:

```js
  function loadPdfJs(cb) {
    if (window.pdfjsLib) { cb(); return; }
    import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.min.mjs')
      .then(m => {
        window.pdfjsLib = m;
        m.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.2.67/build/pdf.worker.min.mjs';
        cb();
      })
      .catch(() => cb());
  }
  function loadSheetJs(cb) {
    if (window.XLSX) { cb(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = cb; s.onerror = cb;
    document.head.appendChild(s);
  }
```

- [ ] **Step 2: Cargar `manifest-core.js` en `index.html`**

Agregar antes del `</body>` (o junto a otros `<script src>`):

```html
<script src="manifest-core.js"></script>
```

- [ ] **Step 3: Agregar `manifest-core.js` a `deploy.sh`**

En `deploy.sh`, en la línea `FILES=...`, agregar `manifest-core.js`:

```bash
FILES="index.html manifest-core.js server.js package.json package-lock.json logo.jpeg logo-nuevo.png boxes.jpeg privacy-policy.html terms-of-service.html data-deletion.html demo.html home.mp4 madrid.png shenzhen.png"
```

- [ ] **Step 4: Verificar sintaxis de los `<script>` inline de `index.html`**

Run (compila cada bloque inline con `vm`, saltea JSON-LD/externos):
```bash
node -e 'const fs=require("fs"),vm=require("vm");const h=fs.readFileSync("index.html","utf8");const re=/<script\b([^>]*)>([\s\S]*?)<\/script>/gi;let m,i=0,bad=0;while(m=re.exec(h)){const a=m[1]||"",b=m[2]||"";if(/\bsrc\s*=/.test(a))continue;if(/application\/ld\+json/.test(a))continue;if(!b.trim())continue;i++;try{new vm.Script(b)}catch(e){bad++;console.log("bloque",i,e.message)}}console.log(bad?("FAIL "+bad):("OK "+i))'
```
Expected: `OK N` (sin bloques con error)

- [ ] **Step 5: Commit**

```bash
git add index.html deploy.sh
git commit -m "feat(manifiesto) cargar pdf.js/SheetJS/manifest-core y sumar a deploy"
```

---

### Task 6: `index.html` — sección "Procesar manifiesto" (UI + preview + acciones)

**Files:**
- Modify: `index.html` (nav sidebar ~1706; nueva `admin-section`; modal de preview; funciones JS junto a las de liquidación)

- [ ] **Step 1: Agregar el ítem de menú (grupo "Principal", junto a "Escáner")**

Después del nav-item de `por-cliente` (~línea 1706):

```html
      <div class="admin-nav-item" onclick="showAdminSection('manifiesto',this)">📄 Procesar manifiesto</div>
```

- [ ] **Step 2: Agregar la sección con el uploader**

Después de la sección `adm-por-cliente` (antes de la que le sigue):

```html
      <!-- PROCESAR MANIFIESTO -->
      <div class="admin-section" id="adm-manifiesto">
        <div class="admin-title">Procesar manifiesto</div>
        <div class="admin-sub">Subí el/los PDF del manifiesto. Consolida por cliente, pasa a "En tránsito" los que ya están y crea los que faltan. Nada se aplica sin tu confirmación.</div>
        <input type="file" id="manif-files" accept="application/pdf" multiple
               style="display:none" onchange="manifOnFiles(this.files)">
        <button class="form-submit" style="margin:0" onclick="document.getElementById('manif-files').click()">📤 Subir manifiesto(s) PDF</button>
        <div id="manif-status" style="margin-top:14px;color:var(--gray);font-size:.85rem"></div>
      </div>
```

- [ ] **Step 3: Agregar el modal de preview**

Junto a los otros `modal-overlay` (p. ej. después de `modal-liq-detail`):

```html
<div class="modal-overlay" id="modal-manif">
  <div class="modal-box" style="max-width:920px;width:96vw;max-height:90vh;display:flex;flex-direction:column">
    <div class="modal-title">Vista previa del manifiesto</div>
    <div id="manif-summary" style="font-size:.85rem;margin-bottom:10px"></div>
    <div id="manif-preview" style="flex:1;overflow-y:auto"></div>
    <div class="modal-actions" style="margin-top:14px;flex-shrink:0">
      <button class="btn-cancel-modal" onclick="closeModal('modal-manif')">Cancelar</button>
      <button class="btn-save" style="background:#5d4037" onclick="manifGenerateDocs()">📄 Solo generar PDF/Excel</button>
      <button class="btn-save" style="background:#2e7d32" onclick="manifConfirmApply()">✅ Confirmar y aplicar</button>
    </div>
  </div>
</div>
```

- [ ] **Step 4: Agregar el glue JS (extracción + preview)**

Junto a las funciones de liquidación en `index.html`:

```js
let manifState = null; // { recs, groups, plan }

async function manifExtractItems(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let items = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    items = items.concat(tc.items.map(it => ({
      str: it.str, x: it.transform[4], y: it.transform[5],
      w: it.width, h: Math.hypot(it.transform[2], it.transform[3]) || it.height || 8,
    })));
  }
  return items;
}

function manifOnFiles(files) {
  if (!files || !files.length) return;
  document.getElementById('manif-status').textContent = 'Leyendo PDF...';
  loadPdfJs(async () => {
    if (!window.pdfjsLib) { alert('No se pudo cargar el lector de PDF.'); return; }
    try {
      let recs = [];
      for (const f of files) {
        const label = f.name.replace(/\.pdf$/i, '').slice(0, 12);
        const items = await manifExtractItems(f);
        const lines = ManifestCore.reconstructLines(items);
        const part = ManifestCore.parseRecords(lines, label);
        if (!part.length) { alert('El archivo "' + f.name + '" no tiene texto legible (¿es un manuscrito/escaneado?). Cargalo a mano.'); }
        recs = recs.concat(part);
      }
      if (!recs.length) { document.getElementById('manif-status').textContent = 'No se detectaron paquetes.'; return; }
      const extra = JSON.parse(localStorage.getItem('manif_alias') || '{}');
      const groups = ManifestCore.groupByClient(recs, extra);
      const plan = ManifestCore.planIngest(recs, adminPackages, adminClients, extra);
      manifState = { recs, groups, plan };
      manifRenderPreview();
      openModal('modal-manif');
      document.getElementById('manif-status').textContent = recs.length + ' paquetes leídos.';
    } catch (e) {
      console.error(e); alert('Error al leer el manifiesto.');
      document.getElementById('manif-status').textContent = 'Error al leer.';
    }
  });
}

function manifRenderPreview() {
  const { recs, groups, plan } = manifState;
  const totalKg = recs.reduce((a, r) => a + r.kilos, 0);
  document.getElementById('manif-summary').innerHTML =
    `<b>${Object.keys(groups).length}</b> clientes · <b>${recs.length}</b> paquetes · <b>${totalKg.toFixed(2)} kg</b>` +
    ` &nbsp;|&nbsp; ✅ ${plan.transit.length} a "En tránsito" · 🆕 ${plan.createAssigned.length} crear (asignados) · ` +
    `📥 ${plan.createUnassigned.length} crear (por asignar) · ⚠️ ${plan.ambiguous.length} ambiguos · ⏭️ ${plan.skip.length} ya avanzados`;
  const box = (title, arr, fmt) => !arr.length ? '' :
    `<div style="margin:10px 0"><div style="font-weight:700;font-size:.85rem;margin-bottom:4px">${title} (${arr.length})</div>` +
    `<div style="font-size:.8rem;color:var(--mid)">${arr.map(fmt).join('<br>')}</div></div>`;
  const clientList = Object.keys(groups).sort().map(n =>
    `<button onclick="manifMergeName('${n.replace(/'/g, "\\'")}')" style="background:#f0f0f0;border:1px solid var(--mist);border-radius:6px;padding:2px 8px;font-size:.75rem;margin:2px;cursor:pointer">${n} ✎</button>`).join('');
  document.getElementById('manif-preview').innerHTML =
    `<div style="margin-bottom:8px"><div style="font-weight:700;font-size:.85rem;margin-bottom:4px">Clientes detectados (tocá para agrupar/renombrar)</div>${clientList}</div>` +
    box('✅ Pasan a "En tránsito" (con email)', plan.transit, x => `${x.client} · ${x.tracking} → ${x.pkg.id}`) +
    box('🆕 Se crean asignados (sin email)', plan.createAssigned, x => `${x.client} · ${x.tracking} · ${x.kilos}kg`) +
    box('📥 Se crean "por asignar"', plan.createUnassigned, x => `${x.client} · ${x.tracking} · ${x.kilos}kg`) +
    box('⚠️ Ambiguos (no se tocan)', plan.ambiguous, x => `${x.client} · ${x.tracking} (${x.matches.length} coincidencias)`) +
    box('⏭️ Ya avanzados (se saltean)', plan.skip, x => `${x.client} · ${x.tracking} → ${x.pkg.estado}`) +
    box('ℹ️ Sin rastreo (solo consolidado)', plan.noTracking, x => `${x.client} · ${x.kilos}kg`);
}

// Agrupar/renombrar un cliente detectado (persiste en localStorage y re-planifica)
function manifMergeName(from) {
  const to = prompt('Agrupar "' + from + '" con qué cliente? (escribí el nombre final)', from);
  if (!to || to === from) return;
  const extra = JSON.parse(localStorage.getItem('manif_alias') || '{}');
  extra[from.toUpperCase()] = to;
  localStorage.setItem('manif_alias', JSON.stringify(extra));
  manifState.groups = ManifestCore.groupByClient(manifState.recs, extra);
  manifState.plan = ManifestCore.planIngest(manifState.recs, adminPackages, adminClients, extra);
  manifRenderPreview();
}
```

- [ ] **Step 5: Verificar sintaxis inline y arranque visual manual**

Run: (mismo chequeo `vm` de la Task 5, Step 4) → Expected `OK N`.
Manual: abrir el sitio local, entrar al panel admin, ir a "Procesar manifiesto", subir `ALAN MANIFIESTOS Y PAGOS 19.6.pdf` y confirmar que aparece la preview con contadores > 0. (Ver Task 8 para levantar el sitio.)

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "feat(manifiesto) sección, uploader y vista previa"
```

---

### Task 7: `index.html` — aplicar cambios + generar PDF/Excel

**Files:**
- Modify: `index.html` (continuación del glue JS)

- [ ] **Step 1: Agregar `manifConfirmApply` (En tránsito + alta de faltantes)**

```js
async function manifConfirmApply() {
  if (!manifState) return;
  const { plan } = manifState;
  const nTransit = plan.transit.length;
  const nCreate = plan.createAssigned.length + plan.createUnassigned.length;
  if (!confirm(`Vas a pasar ${nTransit} paquete(s) a "En tránsito" (les llega email) y crear ${nCreate} nuevo(s). ¿Confirmás?`)) return;
  try {
    if (nTransit) {
      const ids = plan.transit.map(x => x.pkg.id);
      await adminFetch('/api/admin/packages/bulk', { method: 'PUT', body: { ids, fields: { estado: 'En tránsito' } } });
    }
    const toCreate = plan.createAssigned.concat(plan.createUnassigned).map(x => ({
      id: x.tracking, clientId: x.clientId || null, peso: x.kilos,
      deposito: 'Miami', desc: 'Paquete en tránsito (manifiesto)', estado: 'En tránsito',
    }));
    let created = { creados: 0, omitidos: 0 };
    if (toCreate.length) created = await adminFetch('/api/admin/packages/ingest', { method: 'POST', body: { items: toCreate } });
    closeModal('modal-manif');
    await loadAdminData();
    manifGenerateDocs();
    alert(`Listo.\n${nTransit} pasados a "En tránsito".\nCreados: ${created.creados} (omitidos: ${created.omitidos}).`);
  } catch (e) { console.error(e); alert('Error al aplicar los cambios.'); }
}
```

- [ ] **Step 2: Agregar generación de Excel (SheetJS) y PDF (impresión)**

```js
function manifGenerateDocs() {
  loadSheetJs(() => manifBuildExcel());
  manifBuildPdf();
}

function manifBuildExcel() {
  if (!window.XLSX || !manifState) return;
  const { groups } = manifState;
  const names = Object.keys(groups).sort();
  const detalle = [['Cliente', 'Manifiesto', 'Rastreo', 'Kg']];
  const consol = [['Nº', 'Manifiesto', 'Rastreo', 'Kg']];
  let total = 0;
  for (const name of names) {
    const items = groups[name].slice().sort((a, b) => (a.manifest + a.tracking).localeCompare(b.manifest + b.tracking));
    const sub = items.reduce((a, x) => a + x.kilos, 0); total += sub;
    consol.push([name, '', '', '']);
    items.forEach((x, i) => { consol.push([i + 1, x.manifest, x.tracking || '—', +x.kilos.toFixed(2)]); detalle.push([name, x.manifest, x.tracking || '—', +x.kilos.toFixed(2)]); });
    consol.push(['', '', 'Subtotal', +sub.toFixed(2)]);
    consol.push([]);
  }
  consol.push(['TOTAL', '', '', +total.toFixed(2)]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(consol), 'Consolidado');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(detalle), 'Detalle');
  XLSX.writeFile(wb, 'Consolidado manifiesto.xlsx');
}

function manifBuildPdf() {
  const { groups } = manifState;
  const names = Object.keys(groups).sort();
  let total = 0, inner = '';
  for (const name of names) {
    const items = groups[name].slice().sort((a, b) => (a.manifest + a.tracking).localeCompare(b.manifest + b.tracking));
    const sub = items.reduce((a, x) => a + x.kilos, 0); total += sub;
    inner += `<div style="background:#0a0a0a;color:#fff;padding:6px 10px;margin-top:14px;font-weight:800">${name} — ${items.length} paq · ${sub.toFixed(2)} kg</div>`;
    inner += '<table><thead><tr><th>Nº</th><th>Manifiesto</th><th>Rastreo</th><th>Kg</th></tr></thead><tbody>' +
      items.map((x, i) => `<tr><td>${i + 1}</td><td>${x.manifest}</td><td>${x.tracking || '—'}</td><td>${x.kilos.toFixed(2)}</td></tr>`).join('') +
      `<tr class="total-row"><td colspan="3">Subtotal</td><td>${sub.toFixed(2)}</td></tr></tbody></table>`;
  }
  inner += `<div style="background:#0a0a0a;color:#fff;padding:10px;margin-top:16px;font-weight:800;display:flex;justify-content:space-between"><span>TOTAL GENERAL</span><span>${total.toFixed(2)} kg</span></div>`;
  _printDoc('Consolidado de manifiestos', inner);
}
```

- [ ] **Step 3: Verificar sintaxis inline**

Run: (chequeo `vm` de la Task 5, Step 4) → Expected `OK N`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat(manifiesto) aplicar En tránsito + alta de faltantes y generar PDF/Excel"
```

---

### Task 8: Verificación end-to-end local + deploy + verificación en vivo

**Files:** ninguno nuevo (validación y despliegue)

- [ ] **Step 1: Levantar el sitio local y probar el flujo completo en el navegador**

Run:
```bash
(PORT=3999 node server.js >/tmp/boot.log 2>&1 & echo $! >/tmp/boot.pid); sleep 3; echo "http://localhost:3999"
```
Manual: login como admin → "Procesar manifiesto" → subir `ALAN MANIFIESTOS Y PAGOS 19.6.pdf` + `22.6.pdf` → verificar en la preview: 213 paquetes, 704.28 kg, contadores por categoría. Probar "Solo generar PDF/Excel" (baja el .xlsx y abre el PDF). **No** apliques cambios contra la DB local salvo que quieras (creará paquetes de prueba).

- [ ] **Step 2: (Opcional) Probar "Confirmar y aplicar" contra la DB local y limpiar**

Tras aplicar, revertir los cambios de prueba:
```bash
git stash --include-untracked >/dev/null 2>&1 || true   # no aplica a db.json (gitignored)
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('db.json','utf8'));const before=d.packages.length;d.packages=d.packages.filter(p=>!(p.desc==='Paquete en tránsito (manifiesto)'));console.log('removidos',before-d.packages.length);fs.writeFileSync('db.json',JSON.stringify(d,null,2))"
```

- [ ] **Step 3: Matar el server local**

Run: `kill "$(cat /tmp/boot.pid)" 2>/dev/null`

- [ ] **Step 4: Chequeos finales de sintaxis**

Run:
```bash
node --check server.js && node --check manifest-core.js && echo "JS OK"
node -e 'const fs=require("fs"),vm=require("vm");const h=fs.readFileSync("index.html","utf8");const re=/<script\b([^>]*)>([\s\S]*?)<\/script>/gi;let m,i=0,bad=0;while(m=re.exec(h)){const a=m[1]||"",b=m[2]||"";if(/\bsrc\s*=/.test(a)||/application\/ld\+json/.test(a)||!b.trim())continue;i++;try{new vm.Script(b)}catch(e){bad++;console.log("bloque",i,e.message)}}console.log(bad?("FAIL "+bad):("inline OK "+i))'
```
Expected: `JS OK` y `inline OK N`

- [ ] **Step 5: Deploy a producción**

Run: `bash deploy.sh`
Expected: lista de `✓` incluyendo `manifest-core.js`. (Recordar: `deploy.sh` siempre imprime ✓ aunque falle → verificar en vivo abajo.)

- [ ] **Step 6: Verificación en vivo**

Run:
```bash
sleep 8
curl -s https://arboxargentina.com/manifest-core.js | head -c 60
echo; curl -s -o /dev/null -w "core: %{http_code}\n" https://arboxargentina.com/manifest-core.js
curl -s -o /dev/null -w "ingest: %{http_code}\n" -X POST https://arboxargentina.com/api/admin/packages/ingest
curl -s https://arboxargentina.com/index.html | grep -o "showAdminSection('manifiesto'" | head -1
```
Expected: `core: 200`, `ingest: 403` (ruta nueva viva), y aparece `showAdminSection('manifiesto'`.

- [ ] **Step 7: Prueba real acotada en producción (una sola caja)**

Manual: en producción, subir un manifiesto real y en la preview aplicar **solo** si los contadores tienen sentido. Verificar que un cliente registrado matcheado pasó a "En tránsito" y recibió el email.

---

## Notas de ejecución
- El repo no tiene framework de tests: la lógica pura se valida con los harness de Node contra los 2 PDF reales y un fixture sintético; el resto por arranque/curl y verificación en vivo (patrón usado en todo el proyecto).
- `db.json` está en `.gitignore` (no se commitea data). No subir datos de clientes al repo (el fixture de test es sintético).
- Fase 2 (invitaciones) y Fase 3 (registro sin fricción) son planes aparte.
