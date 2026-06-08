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
  campo teléfono **OBLIGATORIO** (con código de país, ej. `54911…`).
  `doRegister` valida presencia + formato; el server rechaza si falta.
- **Admin alta/edición de cliente** (`POST/PUT /api/admin/clients…` + sus
  modales): nuevo campo teléfono.
- Clientes existentes sin teléfono: el admin lo completa editando.
- `server.js`: aceptar y persistir `phone` en register y en alta/edición admin.

### F. QR de entrega → marca ENTREGADO (server + página pública + front)

- **Alcance:** un QR por liquidación; al confirmarlo, **todos** los paquetes de
  esa liquidación pasan a `Entregado`.
- **Token:** al crear la liquidación, el server genera un `deliveryToken`
  aleatorio (`crypto.randomBytes`) y guarda en el movimiento (o en
  `db.deliveries[token]`): `{ clientId, ref, packageIds, delivered:false,
  deliveredAt:null }`. El token vuelve en la respuesta para poder dibujar el QR.
- **QR:** se dibuja en el **PDF de la liquidación** (generado en el front con
  jsPDF) codificando `https://arboxargentina.com/entrega/<token>`. Se agrega una
  librería JS chica de generación de QR (sin llamadas externas).
- **Página pública** (sin login), servida por `server.js` en
  `GET /entrega/:token`: HTML mínimo, mobile-first, muestra cliente + lista de
  paquetes + botón **"Confirmar entrega"** (1 toque).
- **Endpoints:**
  - `GET /api/entrega/:token` → datos de la entrega (cliente, paquetes, si ya
    fue entregada).
  - `POST /api/entrega/:token` → marca todos los paquetes como `Entregado`
    (historial + ts), setea `delivered`/`deliveredAt`. **Idempotente**: si ya
    estaba entregado, responde "ya entregado" sin duplicar.
- Seguridad: el token es aleatorio/no adivinable; la acción es de bajo riesgo e
  idempotente.

### G. Entregados archivados (front)

- "Mis Paquetes" muestra **solo activos** (`renderPackages` excluye
  `estado === 'Entregado'`).
- Nueva sección de sidebar **📦 Entregados** (`#tab-entregados`): lista los
  paquetes entregados (archivo), de solo lectura, con acceso a su vista de
  detalle. Así no se mezclan con los activos.

### H. Escáner de Miami optimizado (front admin)

- En el 🔍 Escáner (`#adm-escaner`), agregar un toggle **"Recibir al instante"**:
  con el toggle ON, cada `scanPkg()` que matchea un paquete lo marca
  **directamente** como `Recibido en origen` (dispara el cambio de estado +
  email) en vez de solo agregarlo a la lista. Con el toggle OFF, queda el
  comportamiento actual (acumular + aplicar en lote).
- Si un tracking escaneado **no matchea** ningún paquete registrado → se crea un
  paquete **No asignado** (ver §I) en estado `Recibido en origen`, capturando
  tracking + depósito (Miami) + nombre del destinatario (opcional, lo lee de la
  etiqueta). Miami sigue escaneando sin trabarse.
- **Reforzar pre-registro:** empujar en el panel del cliente que cargue el
  tracking apenas compra (copy/hint en la pestaña Registrar y en empty states),
  para que Miami solo escanee y nunca tipee datos.
- Nota: el camino **automático** vía 17track (`detectDepotArrival`) ya marca
  "Recibido en origen" solo, para carriers soportados (no Amazon/USPS).

### I. Bandeja de "No asignados" (server + front admin + claim cliente)

- **Modelo:** los paquetes sin dueño se guardan como paquete normal con
  `clientId: null` y `unassigned: true` (reusa la estructura existente; no
  aparecen en el panel de ningún cliente porque se filtra por `clientId`).
- **Bandeja admin** (nueva sección): lista los paquetes con `unassigned: true`
  (tracking, destinatario, depósito, fecha). Acciones:
  - **Asignar a cliente:** buscador de clientes → setea `clientId`, limpia
    `unassigned`, y dispara el email de "recibido" al cliente.
- **Reclamo por el cliente:** en el panel del cliente, "¿Te falta un paquete?
  Ingresá el tracking" → si matchea un paquete `unassigned`, se le asigna a ese
  cliente (setea `clientId`, limpia el flag). Cubre el caso de quien se registró
  después de que el paquete ya llegó.
- **Endpoints:**
  - `POST /api/admin/unassigned` (o reuso de creación) → crea el paquete no
    asignado desde el escáner.
  - `PUT /api/admin/packages/:id/assign` → asigna a un cliente + email.
  - `POST /api/packages/claim` `{ clientId, tracking }` → reclamo del cliente.

### E. Enviar liquidación por WhatsApp (front admin)

- En el modal de liquidación (`#modal-liquidacion`), botón **📲 Enviar por
  WhatsApp** junto a Guardar / Email / PDF.
- `enviarLiquidacionWhatsApp()`: arma
  `https://wa.me/<phone>?text=<mensaje>` con resumen (ref `LIQ-…`, cantidad de
  paquetes, total USD, aviso "podés verlo en tu panel"). Abre en pestaña nueva.
- Si `client.phone` falta → alert pidiendo cargarlo primero.

## Endpoints / cambios de backend (resumen)

- **Nuevo:** `GET /api/packages/:id/tracking` (eventos 17track en vivo + cache).
- **Nuevo:** `GET /entrega/:token` (página pública de confirmación de entrega).
- **Nuevo:** `GET /api/entrega/:token` (datos) y `POST /api/entrega/:token`
  (marca Entregado, idempotente).
- **Modificado:** `POST /api/admin/liquidacion` → guardar `items`/`totalPeso` y
  generar `deliveryToken` (devolverlo en la respuesta).
- **Modificado:** `POST /api/auth/register` (teléfono obligatorio) y endpoints
  admin de clientes → aceptar/guardar `phone`.
- **Nuevo:** `POST /api/admin/unassigned` (crear paquete no asignado desde el
  escáner), `PUT /api/admin/packages/:id/assign` (asignar a cliente + email),
  `POST /api/packages/claim` (reclamo del cliente por tracking).

## Modelo de datos (cambios)

- `client.phone: string` (obligatorio en registros nuevos; formato `54911…`;
  los clientes viejos pueden no tenerlo hasta que el admin lo cargue).
- `movement.items: [{id,desc,deposito,peso,costo}]`, `movement.totalPeso` y
  `movement.deliveryToken` (solo movimientos de liquidación).
- `db.deliveries[token] = { clientId, ref, packageIds, delivered, deliveredAt }`.
- `package.clientId: null` + `package.unassigned: true` para paquetes en la
  bandeja de "No asignados"; `package.destinatario` (nombre leído de la etiqueta).
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
- Teléfono: registro **rechaza sin teléfono**; alta/edición admin; persistencia.
- WhatsApp liquidación: con teléfono abre `wa.me` con texto correcto; sin
  teléfono avisa.
- QR entrega: liquidar genera token; el PDF trae el QR; escanear → página →
  confirmar → todos los paquetes pasan a `Entregado`; segundo escaneo = "ya
  entregado" (idempotente).
- Entregados: tras entregar, los paquetes salen de "activos" y aparecen en
  📦 Entregados.
- Escáner Miami: con "recibir al instante" ON, un escaneo válido marca
  `Recibido en origen` + email; tracking sin match → cae en "No asignados".
- No asignados: asignar a cliente desde admin (setea clientId + email);
  reclamo del cliente por tracking lo asigna a su cuenta.
- Regresión: que los tabs actuales (Resumen, Paquetes, CC, Registrar) sigan
  funcionando; sesión admin 45 min y cliente persistente intactas.

## Fuera de alcance

- Pago online (MercadoPago/checkout).
- WhatsApp automático vía Cloud API (queda manual asistido).
- Rediseño visual / cambio de tema del panel.
- Guardar PDFs de liquidación como archivos en el servidor (se generan en el
  front a demanda).
- Foto/firma de entrega en el QR (queda en "solo confirmar", 1 toque).

## Orden de implementación

1. Teléfono obligatorio + WhatsApp en liquidación + escáner Miami "recibir al
   instante" + bandeja de "No asignados" (asignar/reclamar) — flujo operativo.
2. Entregados archivados (sección aparte; sacar entregados de "activos").
3. Vista dedicada de detalle de paquete (estado + qué sigue, costos, progreso).
4. Seguimiento real 17track (endpoint + timeline en el detalle).
5. QR de entrega (token en liquidación + página pública + endpoints + QR en PDF).
6. Centro de documentos (archivos + PDFs de liquidación/estado de cuenta).

## Archivos afectados

- **Modificado:** `index.html` (vista de detalle, tab Documentos, tab
  Entregados, teléfono obligatorio en registro, botón WhatsApp en liquidación,
  toggle "recibir al instante" en el escáner, fetch de tracking, generación de
  PDFs + QR en el PDF de liquidación).
- **Modificado:** `server.js` (endpoint `/tracking`, items + `deliveryToken` en
  liquidación, página pública `/entrega/:token` + API de entrega, `phone` en
  register/admin clientes).
- **Nuevo (front):** librería JS chica de generación de QR (sin red).
- También: bandeja admin de "No asignados" + reclamo por tracking en el panel
  del cliente (front), y sus endpoints en `server.js`.
