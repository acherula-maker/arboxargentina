// manifest-core.js — lógica pura compartida (navegador + Node). Sin DOM ni pdf.js.
(function (root) {
  'use strict';

  // --- Reconstrucción de líneas a partir de items de texto de pdf.js ---
  // items: [{ str, x, y, w, h }]  (x=transform[4], y=transform[5], w=width, h=alto de fuente)
  function reconstructLines(items) {
    // Los manifiestos están maquetados en varias columnas por página. pdf.js entrega
    // los items en orden de lectura (columna por columna). Recorremos EN ESE ORDEN y
    // cortamos línea al cambiar la Y (>3). Así no se mezclan columnas distintas.
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
