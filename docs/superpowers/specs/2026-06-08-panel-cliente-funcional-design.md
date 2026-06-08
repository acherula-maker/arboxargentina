# Panel de cliente funcional/cómodo + liquidación por WhatsApp — Diseño

Fecha: 2026-06-08
Estado: Aprobado (pendiente review del spec)

## Objetivo

Hacer el panel de cliente de arboxargentina.com **completamente funcional y
cómodo** (no es un rediseño visual). Cerrar los gaps funcionales detectados en
el análisis y agregar el envío de liquidación por WhatsApp.

## Contexto (estado actual)

- Panel de cliente en `index.html` (sección `#dashboard`), 4 tabs: Resumen,
  Mis Paquetes, Cuenta Corriente, Registrar Paquete. Lógica client-side
  (`renderPackages`, `refreshKPIs`, `openHistory`, etc.).
- Backend `server.js` (Express, DB en `db.json`):
  - Paquetes por cliente: `GET /api/packages/:clientId`.
  - Documentos por paquete (ya existen): `POST/GET /api/packages/:id/documents`,
    `GET /api/packages/:id/documents/:docId/download`, `DELETE …`.
  - 17track: `getTrackInfo(trackingNumber)` trae eventos del carrier en vivo,
    pero el webhook **solo** guarda `pkg.ultimoEvento` y cambia el estado; NO
    persiste la línea de tiempo completa.
  - Liquidación: `POST /api/admin/liquidacion` registra un cargo en
    `db.movements` y opcionalmente manda email. **No** guarda los ítems ni un
    PDF descargable.
- Cliente (modelo): `{ id, name, email, username, password, cuit }`.
  **No tiene `phone`.**
- Movimiento CC: `{ fecha, concepto, ref, tipo('Cargo'|'Pago'), monto, clientId }`.

## Decisiones tomadas

1. **Alcance:** Centro de documentos + Seguimiento real (17track) + Detalle
   completo por paquete. **Sin** pago online.
2. **Detalle de paquete:** vista dedicada (pantalla) dentro del panel, con
   "← Volver" integrado al botón Atrás del navegador.
3. **Documentos:** archivos subidos a paquetes (existente) + liquidación/estado
   de cuenta en **PDF generado en el front** al momento.
4. **Liquidación por WhatsApp:** manual asistido (`wa.me` con mensaje pre-armado);
   requiere agregar **teléfono** al cliente.

## Componentes

### A. Vista dedicada de detalle de paquete (front)

- Nueva "pantalla" en el dashboard (ej. `#tab-detalle`, oculta por defecto).
- `openPackageDetail(pkgId)`: oculta los demás tabs, muestra el detalle,
  `pushPanelState()` (para que Atrás vuelva a la lista, no al login).
- Disparadores: click en la fila o botón "Ver" en `renderPackages` y
  `renderRecent`.
- Secciones:
  1. **Encabezado:** `id` (tracking), depósito (`whTag`), descripción, badge de
     estado.
  2. **Estado + "¿Qué sigue?":** texto claro por estado (mapeo
     `ESTADO_EXPLICACION` y `ESTADO_PROXIMO_PASO`), con barra de progreso de las
     6 etapas (`PROG_STEPS`) y la **fecha de cada etapa** tomada de
     `pkg.historial`.
  3. **ETA / cuenta regresiva:** si `estado === 'En tránsito'` y existe
     `pkg.fechaEstimadaEntrega`, mostrar fecha + días restantes.
  4. **Seguimiento real (17track):** línea de tiempo de eventos del carrier
     (ver §C). Estados: cargando (skeleton), "sin eventos aún",
     "no disponible para este envío".
  5. **Costos:** `costo` (flete), `peso`, `valor` declarado, estado de pago
     (`pagado`).
  6. **Documentos del paquete:** listar + descargar (endpoints existentes);
     subir si el estado lo permite (mismo criterio actual del modal de edición).
- Responsive (mobile-first; una columna en pantallas chicas).

### B. Seguimiento real 17track (server: endpoint nuevo)

- `GET /api/packages/:id/tracking?clientId=<id>`.
  - Verifica que `pkg.clientId === clientId` (consistente con el patrón actual
    de endpoints de cliente). Si no coincide → 403.
  - Cache liviano: si `pkg.trackCache` existe y `Date.now() - fetchedAt <
    15*60*1000`, devolverlo. Si no, llamar `getTrackInfo(pkg.id)`, normalizar y
    guardar `pkg.trackCache = { fetchedAt, carrier, events }` (saveDB).
  - Respuesta OK: `{ available:true, carrier, events:[{fecha, descripcion,
    ubicacion}] }`.
  - Respuesta degradada: `{ available:false, motivo }` cuando no hay
    `TRACK17_API_KEY`, el carrier no es soportado (USPS/Amazon), o no hay eventos.
- El front (§A.4) consume este endpoint al abrir el detalle.

### C. Centro de documentos (front + 1 ajuste server)

- Nuevo ítem de sidebar **📄 Documentos** → nuevo tab `#tab-documentos`.
- Contenido:
  1. **Archivos subidos:** recorrer `packages`, juntar `pkg.documents[]`,
     listarlos con descarga (endpoint existente). Agrupados por paquete.
  2. **Liquidaciones (PDF):** por cada movimiento de liquidación (detectado por
     `ref` con prefijo `LIQ-`), botón **Descargar PDF**. Para tener el detalle
     exacto: **ajuste server** — al liquidar, guardar en el movimiento
     `items: [{ id, desc, deposito, peso, costo }]` y `totalPeso`. El PDF se
     arma en el front (motor jsPDF ya presente, ver `downloadLiquidacionPDF`).
  3. **Estado de cuenta (PDF):** botón que genera el resumen completo
     (movimientos + saldo) en el front.

### D. Campo teléfono del cliente (server + front)

- Agregar `phone` al modelo de cliente.
- **Registro** (`#register-form-card` + `doRegister` + `POST /api/auth/register`):
  nuevo campo teléfono (con código de país, ej. `54911…`).
- **Admin alta/edición de cliente** (`POST/PUT /api/admin/clients…` + sus
  modales): nuevo campo teléfono.
- Clientes existentes sin teléfono: el admin lo completa editando.
- `server.js`: aceptar y persistir `phone` en register y en alta/edición admin.

### E. Enviar liquidación por WhatsApp (front admin)

- En el modal de liquidación (`#modal-liquidacion`), botón **📲 Enviar por
  WhatsApp** junto a Guardar / Email / PDF.
- `enviarLiquidacionWhatsApp()`: arma
  `https://wa.me/<phone>?text=<mensaje>` con resumen (ref `LIQ-…`, cantidad de
  paquetes, total USD, aviso "podés verlo en tu panel"). Abre en pestaña nueva.
- Si `client.phone` falta → alert pidiendo cargarlo primero.

## Endpoints / cambios de backend (resumen)

- **Nuevo:** `GET /api/packages/:id/tracking` (eventos 17track en vivo + cache).
- **Modificado:** `POST /api/admin/liquidacion` → guardar `items`/`totalPeso` en
  el movimiento.
- **Modificado:** `POST /api/auth/register` y endpoints admin de clientes →
  aceptar/guardar `phone`.

## Modelo de datos (cambios)

- `client.phone: string` (opcional; formato `54911…`).
- `movement.items: [{id,desc,deposito,peso,costo}]`, `movement.totalPeso` (solo
  movimientos de liquidación).
- `package.trackCache: { fetchedAt, carrier, events }` (cache interno; no se
  expone tal cual).

## Manejo de errores / degradación

- Tracking sin API key / carrier no soportado / sin eventos → mensaje claro, no
  error. El resto del detalle se muestra igual.
- Documentos: si un paquete no tiene archivos, sección vacía con texto guía.
- Liquidación por WhatsApp sin teléfono → aviso, no rompe el flujo.
- Detalle de paquete: si falta un dato (ETA, costo), se omite esa sub-sección.
- Endpoints de cliente: 403 si el `clientId` no es dueño del paquete.

## Testing / verificación

- Sintaxis: `node --check` del JS inline y de `server.js`.
- Detalle: abrir un paquete en cada estado (Registrado → Entregado), verificar
  "¿qué sigue?", progreso con fechas, costos y navegación Atrás.
- Tracking: paquete con tracking real (FedEx/DHL/UPS) → eventos; paquete USPS/
  Amazon o sin key → fallback.
- Documentos: paquete con archivo → descarga; liquidación → PDF con ítems;
  estado de cuenta → PDF.
- Teléfono: registro con teléfono; alta/edición admin; persistencia en `db.json`.
- WhatsApp liquidación: con teléfono abre `wa.me` con texto correcto; sin
  teléfono avisa.
- Regresión: que los tabs actuales (Resumen, Paquetes, CC, Registrar) sigan
  funcionando; sesión admin 45 min y cliente persistente intactas.

## Fuera de alcance

- Pago online (MercadoPago/checkout).
- WhatsApp automático vía Cloud API (queda manual asistido).
- Rediseño visual / cambio de tema del panel.
- Guardar PDFs de liquidación como archivos en el servidor (se generan en el
  front a demanda).

## Orden de implementación

1. Teléfono del cliente + botón WhatsApp en liquidación (chico, valor inmediato).
2. Vista dedicada de detalle de paquete (estado + qué sigue, costos, progreso).
3. Seguimiento real 17track (endpoint + timeline en el detalle).
4. Centro de documentos (archivos + PDFs de liquidación/estado de cuenta).

## Archivos afectados

- **Modificado:** `index.html` (vista de detalle, tab Documentos, campo teléfono
  en registro, botón WhatsApp en liquidación, fetch de tracking, generación de
  PDFs).
- **Modificado:** `server.js` (endpoint `/tracking`, items en liquidación,
  `phone` en register/admin clientes).
