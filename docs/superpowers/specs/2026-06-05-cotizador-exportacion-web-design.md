# Cotizador de exportación FedEx en la web — Diseño

Fecha: 2026-06-05
Estado: Aprobado (pendiente review del spec)

## Objetivo

Llevar el cotizador de exportación FedEx que existe en el agente de WhatsApp
(`Agente Whatsapp/src/services/exportQuotes.ts`) a la web pública
(`index.html`), dentro de la sección `#cotizador`, como un tab "Exportación"
junto al cotizador de importación ya existente.

## Contexto

- **Motor del bot** (`exportQuotes.ts`): dado país destino, peso real (kg) y
  medidas (alto × ancho × largo en cm), calcula:
  - Peso volumétrico = `alto × ancho × largo / 5000`.
  - Peso facturable = `ceil(max(pesoReal, volumétrico) × 2) / 2` (redondeo hacia
    arriba a 0,5 kg).
  - Zona del país destino por cada servicio (Priority / Connect Plus / Economy).
  - Costo FedEx (`priceDesc`) según servicio + zona + peso.
  - Precio cliente = `round2(costo × (1 + combustible) + ganancia/kg × facturable)`.
  - Devuelve hasta 3 servicios con precio (USD) y demora. Omite servicios sin
    zona (`null`) o sin tarifa cargada (no inventa).
- **Constantes de negocio** (`Agente Whatsapp/src/config.ts`):
  combustible = `0.15`, ganancia = `10` USD/kg, divisor volumétrico = `5000`.
- **Datos** (`Agente Whatsapp/seed/data/`):
  - `export-zones.json`: ~200 países → zona por servicio (`A`–`G` o `null`).
  - `export-rates.json`: tarifas fijas (≤20,5 kg, paso 0,5 kg) + 46 bandas
    por-kg para >20,5 kg. Campos: `service`, `zone`, `weightKg`, `bandMin`,
    `bandMax`, `priceList`, `priceDesc`.
- **Web** (`index.html`): la sección `#cotizador` ya tiene un cotizador de
  importación 100% client-side, con tarifas FINALES hardcodeadas en JS
  (no expone costo ni margen). Tiene selector de idioma ES/EN
  (objeto `TRANSLATIONS`).

## Decisiones tomadas

1. **Ubicación**: tab dentro de la sección `#cotizador` existente
   (toggle `Importación | Exportación`).
2. **Arquitectura de datos**: client-side con **precios finales pre-calculados**
   (no expone costo ni margen, consistente con el cotizador de importación).
3. **Entrega del dataset**: archivo JSON estático separado, con **fetch lazy**
   (se descarga solo al abrir el tab "Exportación").
4. **CTA**: botón "Avanzar por WhatsApp" con mensaje pre-armado.

## Arquitectura

Cuatro piezas:

1. **Script de generación** (`scripts/build-fedex-export.js`) — paso de build.
2. **Dataset estático** (`data/fedex-export.json`) — servido junto al sitio.
3. **Motor cliente** — JS dentro de `index.html`.
4. **UI** — tab "Exportación" en `#cotizador`.

### 1. Script de generación (`scripts/build-fedex-export.js`)

Node script, ejecutable con `node scripts/build-fedex-export.js`.

- Lee `Agente Whatsapp/seed/data/export-zones.json` y `export-rates.json`
  (rutas relativas al repo).
- Constantes declaradas arriba del archivo (para cambiarlas fácil):
  `FUEL_PCT = 0.15`, `PROFIT_PER_KG = 10`.
- Helper `round2` idéntico al del bot (`src/lib/math.ts`) para igualar centavos.
- Transforma:
  - **Tarifas fijas** (`bandMin === null`):
    `precioFinal = round2(priceDesc × (1 + FUEL_PCT) + PROFIT_PER_KG × weightKg)`.
  - **Bandas** (`bandMin !== null`):
    `finalPorKg = priceDesc × (1 + FUEL_PCT) + PROFIT_PER_KG`
    (se multiplica por el peso facturable en runtime; el `round2` se aplica al
    producto final en el cliente).
    **Importante**: `finalPorKg` se guarda con precisión completa (NO se
    redondea en el script). El redondeo a centavos ocurre una sola vez, sobre
    `finalPorKg × facturable`, en el cliente — así se replica el orden de
    operaciones del motor del bot y los precios coinciden al centavo. El valor
    del ejemplo de abajo es ilustrativo (en el archivo va con todos los decimales).
- Emite `data/fedex-export.json` con esta forma:

```json
{
  "meta": { "fuelPct": 0.15, "profitPerKg": 10, "volumetricDivisor": 5000,
            "generatedFrom": "Agente Whatsapp/seed/data" },
  "zones": [
    { "code": "DE", "name": "Alemania",
      "priority": "D", "connectPlus": "B", "economy": "D" }
  ],
  "rates": {
    "fixed": { "priority|A|0.5": 89.43, "economy|D|1": 132.10 },
    "bands": [
      { "service": "priority", "zone": "A", "min": 21, "max": 44,
        "finalPorKg": 54.51 }
    ]
  }
}
```

Clave de `fixed`: `"<service>|<zone>|<weightKg>"`.

### 2. Dataset estático (`data/fedex-export.json`)

- ~200 países + ~900 tarifas fijas + 46 bandas. Tamaño estimado 60–80 KB.
- Se sirve estáticamente (el server ya hace `express.static(__dirname)`).
- Es un artefacto generado; se versiona en el repo para no depender del build en
  producción.

### 3. Motor cliente (en `index.html`)

Replica `exportQuotes.ts`. Funciones JS:

- `loadFedexData()`: hace `fetch('data/fedex-export.json')` una sola vez
  (memoizado en una variable módulo). Se invoca al abrir el tab "Exportación".
- `normalizeCountry(s)`: `s.normalize('NFD').replace(/[̀-ͯ]/g,'')
  .trim().toLowerCase()` — igual al `norm` del bot.
- `lookupZone(paisDestino, data)`: match por nombre normalizado o `code`; si no
  hay match → fila cuyo `name` matchea `/resto del mundo/i` (fallback). Devuelve
  la fila de zona o `null`.
- `volumetricWeight(alto, ancho, largo)` = `alto*ancho*largo / 5000`.
- `billableWeight(real, vol)` = `Math.ceil(Math.max(real, vol) * 2) / 2`.
- `round2(n)`: idéntico al del bot.
- `lookupRate(service, zone, facturable, data)`:
  - Si `facturable <= 20.5`: busca `data.rates.fixed["service|zone|facturable"]`
    → `{ kind: 'fixed', precio }` o `null`.
  - Si `> 20.5`: busca la banda con `service`, `zone`, `min <= facturable` y
    (`max == null || max >= facturable`) → `{ kind: 'band', finalPorKg }` o `null`.
- `cotizarExportacion(input, data)`:
  - Valida `pesoReal > 0` y las tres medidas `> 0`.
  - Calcula `facturable`.
  - Resuelve la zona; por cada servicio (Priority / Connect Plus / Economy):
    - Si la zona del servicio es `null`/`"-"` → omite (no disponible).
    - Busca tarifa; si no hay → omite.
    - `precio = fixed ? precio : round2(finalPorKg × facturable)`.
  - Devuelve `[{ service, label, demora, zona, precio }]` (hasta 3) + `facturable`.

Metadatos de servicios (igual al bot):

| service        | label                              | demora            |
|----------------|------------------------------------|-------------------|
| priority       | FedEx International Priority        | 2–4 días hábiles  |
| connect_plus   | FedEx International Connect Plus    | 3–5 días hábiles  |
| economy        | FedEx International Economy         | 5–7 días hábiles  |

### 4. UI (dentro de `#cotizador`)

- **Toggle principal** arriba del `quoter-wrap`: `Importación | Exportación`.
  Por defecto "Importación" (estado actual sin cambios). Al activar "Exportación"
  se ocultan los paneles de importación y se muestra el panel de exportación;
  dispara `loadFedexData()` (lazy).
- **Panel de exportación** (misma estética, reusa clases `calc-card`, `calc-field`,
  `calc-result`, etc.):
  - **País destino**: `<input list="export-paises">` + `<datalist>` poblado desde
    `data.zones` (nombres). Buscable, nativo, sin librerías.
  - **Peso real (kg)**: number, `min=0.1 step=0.1`.
  - **Alto / Ancho / Largo (cm)**: tres inputs number, `min=1 step=1`.
  - Cálculo **en vivo** (`oninput`/`onchange`) cuando los 5 campos son válidos.
  - **Resultados**: lista de servicios disponibles (nombre, demora, precio USD).
    Muestra el peso facturable usado. Si un servicio no aplica al destino, no
    aparece. Si ningún servicio aplica → mensaje "No tenemos tarifa para ese
    destino, escribinos por WhatsApp".
  - **CTA**: botón "Avanzar por WhatsApp" → `https://wa.me/5491171473919?text=...`
    con país, peso, medidas y servicios cotizados pre-armados (URL-encoded).
  - **Disclaimer**: "Valores orientativos en USD. No incluye seguro ni gestión
    aduanera de destino."
- **Panel informativo** (columna izquierda, reusa `rate-panel`): explica los 3
  servicios FedEx y qué es el peso volumétrico (divisor 5000).

### 5. i18n

Agregar claves nuevas (toggle, labels de campos, botón, disclaimer, títulos del
panel info) al objeto `TRANSLATIONS` existente, en ES y EN. El selector de idioma
ya existe; solo se extiende.

## Flujo de datos

```
Usuario abre tab "Exportación"
  → loadFedexData() (fetch lazy, memoizado)
Usuario completa país + peso + medidas
  → cotizarExportacion(input, data)
      → billableWeight, lookupZone, por servicio lookupRate
  → render lista de servicios (label, demora, precio) + facturable
Usuario click "Avanzar por WhatsApp"
  → abre wa.me con mensaje pre-armado
```

## Manejo de errores / casos borde

- Campos incompletos o ≤0 → no calcula, muestra "—" (sin error ruidoso).
- País sin match → usa fallback "Resto del mundo".
- Servicio con zona `null` → se omite silenciosamente.
- Servicio sin tarifa para esa zona/peso → se omite (no se inventa precio).
- Ningún servicio disponible → mensaje + CTA a WhatsApp.
- `fetch` del dataset falla → mensaje "No se pudo cargar el cotizador, probá de
  nuevo o escribinos por WhatsApp".

## Testing / verificación

- **Paridad con el bot**: elegir 3–4 combinaciones (país + peso + medidas),
  correr el CLI del bot (`Agente Whatsapp/cli/cotizar` o el motor) y comparar el
  precio de cada servicio contra la web. Deben coincidir al centavo.
- Caso banda (>20,5 kg) y caso peso volumétrico dominante.
- Caso destino con servicio no disponible (ej. país con `zonePriority: null`).
- Caso "Resto del mundo".

## Fuera de alcance (YAGNI)

- Sin cambios en `server.js` ni endpoints nuevos.
- Sin formulario de leads ni envío de email.
- Sin integración en vivo con la API de FedEx (se usan tarifas cargadas).
- Sin login: el cotizador es público, igual que el de importación.

## Mantenimiento

Si cambian tarifas, combustible o ganancia/kg: actualizar la fuente
(`Agente Whatsapp/seed/data/*` y/o las constantes del script) y re-correr
`node scripts/build-fedex-export.js` para regenerar `data/fedex-export.json`.

## Archivos afectados

- **Nuevo**: `scripts/build-fedex-export.js`
- **Nuevo**: `data/fedex-export.json` (generado)
- **Modificado**: `index.html` (markup del tab + motor JS + claves i18n)
