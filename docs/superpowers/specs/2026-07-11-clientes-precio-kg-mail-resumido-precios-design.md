# Diseño — Cambios en clientes, liquidaciones y precios

**Fecha:** 2026-07-11
**Rama:** `feat/agregar-paquete-manual-por-cliente`

## Contexto

Cuatro pedidos del dueño del negocio (Arbox Argentina — courier de importación):

1. Campo de WhatsApp en clientes + mandar liquidaciones por WhatsApp.
2. Campo "precio por kg" en el cliente para que la liquidación calcule sola.
3. Cuando cambian varios paquetes de estado, hoy se manda un mail por paquete
   (un cliente con 50 paquetes recibe 50 mails). Mandar **un solo mail resumido**.
4. Nueva escala de precios (Sin CUIT) en la web y en el bot de WhatsApp.

## Estado actual (hallazgos)

- **#1 ya está implementado y commiteado** (commit `1babc65`). El cliente ya tiene
  campo `phone` (label "WhatsApp / Teléfono", `#mcli-phone`). La función
  `enviarLiquidacionWhatsApp()` ([index.html:4924](../../../index.html)) arma el mensaje
  y abre `wa.me`; también existe `reenviarLiquidacionWA(ref)` para liquidaciones
  guardadas. **No hay nada que construir para #1** — solo cargar los números.
- Hay cambios sin commitear en `index.html`/`server.js`: son la feature "Total a
  cobrar (USD)" (total manual / lump-sum). **No se tocan.**
- **#2 `precioKg` no existe** en ningún lado.
- Precios actuales en 3 lugares: `RATES` JS ([index.html:2341](../../../index.html)),
  paneles de tarifas ([index.html:1166](../../../index.html)), y el bot
  (`Agente Whatsapp/src/data/importTariffs.ts`, proyecto separado con Postgres).

## Alcance

Construir **#2, #3 y #4**. #1 queda como está.

---

## Feature 2 — Precio por kg del cliente → cálculo automático

**Modelo de datos:** nuevo campo opcional `precioKg` (número, USD/kg) en cada cliente.
Base JSON: ausente = sin precio configurado. Sin migración.

**Backend (`server.js`):**
- Agregar `'precioKg'` al array `allowed` del endpoint editar cliente
  (`PUT /api/admin/clients/:id`, ~línea 1453).
- Aceptar `precioKg` en crear cliente (`POST /api/admin/clients`, ~línea 1478),
  guardado como `Number(precioKg) || undefined`.
- El endpoint que lista clientes ya devuelve el objeto cliente completo, así que
  `precioKg` llega solo al front (verificar que no se filtre).

**Admin UI (`index.html`):**
- Nuevo input `#mcli-precio` (number, step 0.01, min 0) en el modal de cliente,
  al lado de CUIT (~línea 2263). Label: "Precio por kg (USD)".
- `editClient()` (~4211): poblar `#mcli-precio` con `c.precioKg ?? ''`.
- `saveClient()` (~4223): incluir `precioKg: parseFloat(#mcli-precio) || null`.

**Modal de liquidación (`index.html` `openLiquidacion`, ~4854):**
- Al abrir, si el cliente tiene `precioKg`, prefijar cada input `.liq-costo` con
  `(peso × precioKg)` redondeado a 2 decimales (en vez de `p.costo`).
- Mostrar el precio del cliente en el encabezado del modal:
  "Precio del cliente: USD X/kg" (o "sin precio por kg configurado").
- Botón "Aplicar precio × kg" que recalcula todos los `.liq-costo = peso × precioKg`
  (útil si se editan pesos). Sin `precioKg`, el botón se oculta/deshabilita.
- El "Total a cobrar (USD)" manual sigue prevaleciendo si se completa (no se cambia
  esa lógica). El cálculo por kg solo llena los costos por paquete.

**Sin cambios de servidor en la liquidación:** el server ya recibe `costo` por
paquete; el cálculo por kg es solo del lado del panel.

---

## Feature 3 — Un solo mail resumido por cliente (bulk)

**Problema:** `PUT /api/admin/packages/bulk` ([server.js:1336](../../../server.js))
arma `toNotify` con un item **por paquete** y hace
`Promise.allSettled(toNotify.map(sendStatusChangeEmail))` → un mail por paquete.

**Cambio:**
- Agrupar los cambios por `client.id`:
  `Map<clientId, { client, changes: [{ pkg, oldStatus, newStatus }] }>`.
- Después de responder, por cada cliente enviar **un** mail con
  `sendStatusDigestEmail(client, changes)`.
- Nueva función `sendStatusDigestEmail(client, changes)` en `server.js`
  (junto a `sendStatusChangeEmail`, ~línea 330). Reutiliza el estilo del mail
  existente. Contenido: tabla con Tracking · Descripción · Depósito ·
  "Estado anterior → Estado nuevo" por cada paquete, + botón "Ver mi Panel".
  Subject: `📦 Actualización de tus paquetes (${changes.length}) — Arbox Argentina`.
- Sigue habiendo un mail por cliente, en paralelo, en segundo plano (igual que hoy),
  pero **agrupado**.

**Fuera de alcance del cambio:** los mails individuales de un solo paquete siguen
igual (actualización del cliente `PUT .../estado` ~1157, y webhook 17track ~1731).
Solo se agrupa la **actualización masiva del admin**, que es donde nacía el spam.

**Nota:** si un cliente tiene un solo paquete en la tanda, recibe el mail resumido
con una sola fila (comportamiento consistente, simple).

---

## Feature 4 — Nueva escala de precios (Sin CUIT)

Con CUIT (solo flete) **no cambia**. Solo Sin CUIT (todo incluido).

| Banda | 🇺🇸 USA | 🇨🇳 China / 🇪🇸 España |
|---|---|---|
| 1–25 kg | 50 | 65 |
| 26–50 kg | 45 | 60 *(26–60)* |
| 51–150 kg | 42 | 55 *(61–150)* |
| +151 kg | 40 | 50 |

USA: bandas 1–25 / 26–50 / 51–150 / 151+.
China/España: bandas 1–25 / 26–60 / 61–150 / 151+.

**Web — calculadora JS (`index.html` `RATES`, ~2341):**
```js
sin: {
  miami: [[25,50],[50,45],[150,42],[Infinity,40]],
  china: [[25,65],[60,60],[150,55],[Infinity,50]],
}
```
(`con` queda igual.)

**Web — paneles de tarifas (`index.html` `#panel-sincuit`, ~1166):**
- Miami: 4 filas → 1–25:50 / 26–50:45 / 51–150:42 / +151:40.
- China/España: 4 filas → 1–25:65 / 26–60:60 / 61–150:55 / +151:50.
- Agregar demora por origen (dato provisto): USA "🕓 Demora estimada: 4 días
  hábiles", China/España "🕓 Demora estimada: 7 días hábiles".

**Bot (`Agente Whatsapp/src/data/importTariffs.ts`) — `sin_cuit`:**
```
usa:    (1,25,50) (26,50,45) (51,150,42) (151,null,40)
china:  (1,25,65) (26,60,60) (61,150,55) (151,null,50)
espana: (1,25,65) (26,60,60) (61,150,55) (151,null,50)
```
(`con_cuit` queda igual.)

**Deploy del bot (separado del de la web):** el bot lee de Postgres. Tras editar el
archivo hay que, en el entorno del bot: `npm run seed` (borra y recarga
`import_tariffs`). Si el bot corre compilado, además `npm run build`. Es un deploy
independiente del de arboxargentina.com (Hostinger).

**Demoras del bot (confirmado: alinear):** el prompt del bot dice "Miami 7–14 días,
China 14–21 días" ([systemPrompt.ts:33](../../../Agente%20Whatsapp/src/brain/systemPrompt.ts)).
Se actualiza a las demoras del spec: **USA 4 días hábiles**, **China/España 7 días
hábiles**.

---

## Archivos afectados

- `server.js` — #2 (endpoints cliente), #3 (bulk + `sendStatusDigestEmail`).
- `index.html` — #2 (modal cliente + modal liquidación), #4 (RATES + paneles).
- `Agente Whatsapp/src/data/importTariffs.ts` — #4 (bandas sin_cuit) + re-seed.
- `Agente Whatsapp/src/brain/systemPrompt.ts` — #4 (demoras: USA 4 / China-España 7 días hábiles).

## Fuera de alcance

- #1 WhatsApp (ya implementado).
- Precios Con CUIT (sin cambios).
- Envío automático de WhatsApp (API oficial) — descartado.
- Plazos/demoras del prompt del bot (a confirmar aparte).
- Los cambios sin commitear de "Total a cobrar (USD)".

## Testing / verificación

- **#2:** crear/editar cliente con `precioKg`; abrir liquidación → costos prefijados
  = peso × precioKg; total correcto; "Total a cobrar" manual sigue prevaleciendo.
- **#3:** actualizar en lote N paquetes de un mismo cliente → llega **un** mail con N
  filas. Dos clientes en la misma tanda → un mail cada uno. Verificar en logs
  `[bulk]` que no salen N mails.
- **#4 web:** calculadora con pesos límite (25, 26, 50, 51, 60, 61, 150, 151) para
  USA y China → tarifa correcta; paneles muestran 4 filas + demora.
- **#4 bot:** `npm run seed` y `npm run cotizar` (o test) con pesos límite.
