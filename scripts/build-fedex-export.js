#!/usr/bin/env node
/**
 * Genera data/fedex-export.json a partir de los datos del agente de WhatsApp.
 *
 * Lee:
 *   Agente Whatsapp/seed/data/export-zones.json   (zona por país y servicio)
 *   Agente Whatsapp/seed/data/export-rates.json   (tarifas costo FedEx, priceDesc)
 *
 * Aplica las constantes de negocio (combustible + ganancia/kg) y emite un
 * dataset con PRECIOS FINALES — nunca expone el costo (priceDesc) ni el margen.
 *
 * Uso:  node scripts/build-fedex-export.js
 *
 * Si cambian tarifas, combustible o ganancia/kg: actualizá la fuente y/o estas
 * constantes y volvé a correr el script para regenerar data/fedex-export.json.
 */
"use strict";

const fs = require("fs");
const path = require("path");

// ── Constantes de negocio (deben coincidir con el bot: Agente Whatsapp/src/config.ts) ──
const FUEL_PCT = 0.15; // recargo de combustible
const PROFIT_PER_KG = 10; // ganancia en USD por kg facturable
const VOLUMETRIC_DIVISOR = 5000; // informativo (el cálculo volumétrico vive en el cliente)

// round2 idéntico a Agente Whatsapp/src/lib/math.ts (evita errores de redondeo IEEE-754)
function round2(n) {
  return Number(`${Math.round(Number(`${n}e2`))}e-2`);
}

const SEED_DIR = path.join(__dirname, "..", "Agente Whatsapp", "seed", "data");
const OUT_FILE = path.join(__dirname, "..", "data", "fedex-export.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), "utf8"));
}

function main() {
  const zonesRaw = readJson("export-zones.json");
  const ratesRaw = readJson("export-rates.json");

  const zones = zonesRaw.map((z) => ({
    code: z.countryCode,
    name: z.countryName,
    priority: z.zonePriority,
    connectPlus: z.zoneConnectPlus,
    economy: z.zoneEconomy,
  }));

  const fixed = {};
  const bands = [];

  for (const r of ratesRaw) {
    const priceDesc = Number(r.priceDesc);
    if (r.bandMin == null) {
      // Tarifa fija (≤ 20,5 kg): precio final ya redondeado.
      const finalPrice = round2(priceDesc * (1 + FUEL_PCT) + PROFIT_PER_KG * r.weightKg);
      fixed[`${r.service}|${r.zone}|${r.weightKg}`] = finalPrice;
    } else {
      // Banda por-kg (> 20,5 kg): se guarda el precio final POR KG sin redondear.
      // El round2 se aplica en el cliente sobre finalPorKg × pesoFacturable, para
      // replicar el orden de operaciones del bot y coincidir al centavo.
      bands.push({
        service: r.service,
        zone: r.zone,
        min: r.bandMin,
        max: r.bandMax, // puede ser null (banda abierta)
        finalPorKg: priceDesc * (1 + FUEL_PCT) + PROFIT_PER_KG,
      });
    }
  }

  const out = {
    meta: {
      fuelPct: FUEL_PCT,
      profitPerKg: PROFIT_PER_KG,
      volumetricDivisor: VOLUMETRIC_DIVISOR,
      generatedFrom: "Agente Whatsapp/seed/data",
      zones: zones.length,
      fixedRates: Object.keys(fixed).length,
      bands: bands.length,
    },
    zones,
    rates: { fixed, bands },
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out));
  console.log(
    `OK → ${path.relative(path.join(__dirname, ".."), OUT_FILE)}: ` +
      `${zones.length} zonas, ${Object.keys(fixed).length} tarifas fijas, ${bands.length} bandas.`,
  );
}

main();
