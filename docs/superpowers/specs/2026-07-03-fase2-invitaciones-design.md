# Fase 2 — Invitaciones a clientes

Fecha: 2026-07-03
Estado: aprobado (diseño), pendiente de implementación

## Objetivo

Que los clientes **sin cuenta** que ya tienen paquetes cargados (por el procesamiento de
manifiestos de Fase 1) creen su cuenta mediante un **link de invitación** que el admin les
manda por WhatsApp. Al crear la cuenta, sus paquetes se **enlazan solos**.

Resuelve el problema de adopción: en vez de perseguir a los clientes para que carguen sus
paquetes, se los invita con las cosas ya cargadas ("creá tu cuenta para verlos").

## Alcance

**Incluye:**
- Guardar el nombre del cliente (`destinatario`) en los paquetes "por asignar" auto-creados (gap de Fase 1).
- Sección admin "Invitaciones": lista de clientes sin cuenta con paquetes, con botón "Generar invitación".
- Generación de link único por cliente + mensaje de WhatsApp listo para copiar/enviar (el admin lo manda).
- Página de invitación (`/invitacion/<token>`): muestra los paquetes + formulario corto de alta.
- Alta con token: crea la cuenta, reclama los paquetes y deja al cliente logueado.

**Fuera de alcance (v1):**
- Recordatorios a clientes que **ya tienen cuenta** pero no entran.
- Envío automático de mensajes (el admin envía manualmente desde su WhatsApp).
- Cargar/gestionar contactos en el sistema.
- Vencimiento de links (no vencen; son idempotentes).

## Modelo de datos

- `db.invites[token]` = `{ name, packageIds: [ids], createdAt, usedAt: null }`.
  `token` = `crypto.randomBytes(16).toString('hex')`.
- Paquetes: se **puebla `destinatario`** en los auto-creados "por asignar" (hoy queda `''`).
- No hay migración; campos nuevos/opcionales.

## Componentes

### 1. Gap de Fase 1 (`destinatario`)
- Frontend `manifConfirmApply` (`toCreate`): agregar `destinatario: x.client` a cada item creado.
- Backend `POST /api/admin/packages/ingest`: guardar `destinatario: it.destinatario || ''` en el paquete creado
  (hoy está hardcodeado `destinatario: ''`).

### 2. Admin — sección "Invitaciones"
- Nuevo nav-item "✉️ Invitaciones" y sección `adm-invitaciones`.
- `renderInvitaciones()`: agrupa `adminPackages` con `unassigned === true` (o `clientId == null`) por
  `destinatario` (ignorando vacíos), y lista: nombre · nº paquetes · botón "Generar invitación".
- Al generar: `POST /api/admin/invites { name }` → devuelve `{ token, url, count }`.
  Muestra un bloque con el **mensaje de WhatsApp** (plantilla abajo) + el link, botón "Copiar",
  y opción "Abrir WhatsApp" (`https://wa.me/?text=...`, sin número, para elegir el contacto).
- Plantilla del mensaje:
  `Hola {name}! 👋 Tenés {N} paquete(s) en Arbox ya cargados. Creá tu cuenta para seguirlos y coordinar la entrega: {url}`

### 3. Cliente — página de invitación
- Ruta `/invitacion/<token>` → la sirve el catch-all como `index.html` (server.js:1940).
- En el arranque de la app, detectar `location.pathname` que empiece con `/invitacion/`:
  - `GET /api/invitacion/:token` → `{ valid, name, packages: [{id, desc, estado}] }`.
  - Si `valid`, mostrar una **vista de invitación** (oculta landing y panel): saludo "Hola {name} 👋,
    estos son tus paquetes en Arbox:" + lista de paquetes + **formulario corto de alta**.
  - Formulario corto: `name` precargado (bloqueado), **email** y **contraseña** requeridos, **teléfono** opcional.
    `username` se deriva del email (parte antes de la @, con sufijo numérico si está tomado).
- Al enviar: `POST /api/auth/register-invite { token, email, password, phone? }` → si OK, guardar
  `localStorage 'arbox_session' = { client }` (igual que `doLogin`) y entrar al panel del cliente.

### 4. Backend — endpoints
- `POST /api/admin/invites` (requireAdmin): body `{ name }`. Junta `packageIds` de `db.packages`
  con `unassigned === true` y `destinatario === name`. Si no hay, 400. Crea `db.invites[token]`.
  Devuelve `{ token, url: <origin>/invitacion/<token>, count }`.
- `GET /api/invitacion/:token` (público): busca el invite; si no existe → `{ valid:false }`.
  Si existe, arma `packages` desde `packageIds` (id, desc, estado). Devuelve `{ valid:true, name, packages }`.
- `POST /api/auth/register-invite` (público): body `{ token, email, password, phone }`.
  - Valida token, email y contraseña (≥6). Rechaza email/username ya en uso.
  - Crea el cliente `{ id, name: invite.name, email, phone: phone||'', username, password }`.
  - **Reclama** cada `packageId` del invite: si el paquete existe y (`unassigned` o sin `clientId` firme),
    setea `clientId = nuevo`, `unassigned = false`. (Idempotente: si ya está tomado, lo saltea.)
  - Marca `invite.usedAt = Date.now()`.
  - Devuelve `{ ok, client }` (sin password), para auto-login.

## Casos borde
- Link reusado / paquetes ya reclamados → el claim saltea los ya tomados; el alta puede fallar por email
  duplicado (mensaje claro). No rompe datos.
- Cliente ya registrado con ese email → el alta devuelve error "email ya registrado" (puede loguearse normal).
- Nombre con varios homónimos → el admin agrupa por nombre tal cual; si hay ambigüedad, la maneja él.
- `destinatario` vacío (paquetes viejos) → no aparecen en la lista de invitaciones (no se pueden agrupar).

## Verificación
- Gap: ingest con `destinatario` → el paquete lo guarda (integración).
- `POST /api/admin/invites` → token creado con los packageIds correctos (integración con login admin).
- `GET /api/invitacion/:token` → devuelve nombre + paquetes.
- `POST /api/auth/register-invite` → crea cuenta, reclama paquetes (quedan con el nuevo clientId,
  unassigned=false), marca invite usado; segundo intento con mismo email → error claro.
- Sintaxis (`node --check`, bloques inline), arranque del server.
- Verificación del flujo en navegador (la vista de invitación aparece en `/invitacion/<token>`).

## Riesgos
- Auto-login tras el alta: reusar exactamente el guardado de sesión de `doLogin` (`arbox_session`).
- Derivación de username: evitar colisiones (sufijo numérico).
- La vista de invitación no debe romper el flujo normal de la app (solo se activa con `/invitacion/`).
