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

  const api = { reconstructLines, parseRecords };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ManifestCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
