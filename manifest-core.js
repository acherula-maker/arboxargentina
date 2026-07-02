// manifest-core.js — lógica pura compartida (navegador + Node). Sin DOM ni pdf.js.
(function (root) {
  'use strict';

  // --- Reconstrucción de líneas a partir de items de texto de pdf.js ---
  // items: [{ str, x, y, w, h }]  (x=transform[4], y=transform[5], w=width, h=alto de fuente)
  const Y_TOLERANCE = 3;            // salto de Y (pt) que separa dos líneas
  const SPACE_WIDTH_FACTOR = 0.25;  // hueco mínimo (× alto de fuente) para insertar espacio
  const DEFAULT_FONT_HEIGHT = 8;    // alto de fuente por defecto si el item no lo trae

  function reconstructLines(items) {
    // Los manifiestos están maquetados en varias columnas por página. pdf.js entrega
    // los items en orden de lectura (columna por columna). Recorremos EN ESE ORDEN y
    // cortamos línea al cambiar la Y. Así no se mezclan columnas distintas.
    function joinLine(group) {
      const its = group.slice().sort((a, b) => a.x - b.x);
      let line = '', prev = null;
      for (const it of its) {
        if (prev) {
          const gap = it.x - (prev.x + (prev.w || 0));
          const spaceW = SPACE_WIDTH_FACTOR * (it.h || DEFAULT_FONT_HEIGHT);
          line += gap > spaceW ? ' ' : '';
        }
        line += it.str;
        prev = it;
      }
      return line.replace(/\s+/g, ' ').trim();
    }
    const lines = [];
    let cur = [], curY = null;   // curY = Y de referencia (primer item de la línea actual)
    for (const it of items) {
      if (!it.str) continue;
      if (curY !== null && Math.abs(it.y - curY) > Y_TOLERANCE) {
        const l = joinLine(cur); if (l) lines.push(l);
        cur = []; curY = null;
      }
      if (curY === null) curY = it.y;
      cur.push(it);
    }
    const last = joinLine(cur); if (last) lines.push(last);
    return lines;
  }

  // --- Parseo de registros a partir de líneas de texto ---
  // NOISE: tokens de encabezados/subtotales que NO son filas de datos ("CAJ" filtra las
  // filas "CAJA 4313 TOTAL:...KGS"). Match sensible a mayúsculas: los encabezados vienen
  // en mixed-case ("Cliente", "Nº de rastreo") y los datos en MAYÚSCULAS, así que "de"
  // no colisiona con nombres de cliente. CLIENT_NOISE: tokens que no son cliente (PCS, GB).
  const NOISE = ['CAJ', 'KGS', 'ALAN', 'TOTAL', 'Cliente', 'rastreo', 'Kilos', 'de', 'Nº'];
  const CLIENT_NOISE = new Set(['PCS', 'PC', 'GB']);
  const UP = 'A-ZÁÉÍÓÚÜÑ';  // mayúsculas incluyendo acentos del español
  const isInt = t => /^\d+$/.test(t);
  const isKilos = t => /^\d+\.\d+$/.test(t);
  const isAlpha = t => new RegExp('^[' + UP + ']+$').test(t) && !CLIENT_NOISE.has(t);
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
        const m = line.match(new RegExp('^(?:\\d+\\s+)?([' + UP + '][' + UP + ' ]*[' + UP + ']|[' + UP + ']+)$'));
        if (m) {
          const words = m[1].split(/\s+/).filter(w => !CLIENT_NOISE.has(w));
          if (words.length) lastClient = words.join(' ');
        }
      }
    }
    return recs;
  }

  // --- Alias (negocio + artefactos de extracción del 22.6) ---
  // Incluye alias de negocio (mismo cliente con distinto nombre) y artefactos de
  // extracción de pdf.js en PDFs con letter-spacing (p.ej. "CALDERO NE" → CALDERONE).
  const ALIAS = {
    'VALERIA CALDERON': 'CALDERONE', 'VALERIA CALDERO N': 'CALDERONE',
    'CALDERO NE': 'CALDERONE', 'CALDERONE': 'CALDERONE',
    'SCONF': 'SCONFIETTI', 'SCO NF': 'SCONFIETTI', 'SCO NFIETTI': 'SCONFIETTI', 'SCONFIETTI': 'SCONFIETTI',
    'MIGUES': 'MIGUEZ', 'MIGUEZ': 'MIGUEZ',
    'CACOPARDO': 'CALOPARDO', 'CACO PARDO': 'CALOPARDO',
    'MONICA CACOPAR': 'CALOPARDO', 'MO NICA CACO PAR': 'CALOPARDO', 'CALOPARDO': 'CALOPARDO',
    'ELI': 'ELIANA', 'ELIANA': 'ELIANA',
    'ACO STA': 'ACOSTA', 'ACOSTA': 'ACOSTA',
    'CO RTEZ': 'CORTEZ', 'CORTEZ': 'CORTEZ',
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

  // --- Matcheo contra la base + plan de ingesta ---
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

  // recs: registros parseados. packages/clients de la base. Categoriza para la preview.
  function planIngest(recs, packages, clients, extraAlias) {
    const plan = { transit: [], skip: [], ambiguous: [], createAssigned: [], createUnassigned: [], noTracking: [] };
    for (const r of recs) {
      const canon = canonicalize(r.client_raw, extraAlias);
      if (!r.tracking || /PCS/i.test(r.tracking)) { plan.noTracking.push(Object.assign({ client: canon }, r)); continue; }
      const m = matchBySuffix(r.tracking, packages);
      if (m.status === 'ambiguous') { plan.ambiguous.push(Object.assign({ client: canon, matches: m.matches }, r)); continue; }
      if (m.status === 'exact' || m.status === 'suffix') {
        const pkg = m.matches[0];
        if (ADVANCED.has(pkg.estado)) plan.skip.push(Object.assign({ client: canon, pkg }, r));
        else plan.transit.push(Object.assign({ client: canon, pkg }, r));
        continue;
      }
      const cli = findClientsByName(canon, clients);
      if (cli.length === 1) plan.createAssigned.push(Object.assign({ client: canon, clientId: cli[0].id }, r));
      else plan.createUnassigned.push(Object.assign({ client: canon, clientId: null }, r));
    }
    return plan;
  }

  const api = {
    reconstructLines, parseRecords, ALIAS, canonicalize, groupByClient,
    matchBySuffix, findClientsByName, planIngest,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ManifestCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
