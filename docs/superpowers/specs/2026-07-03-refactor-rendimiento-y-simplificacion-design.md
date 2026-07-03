# Refactor: rendimiento + simplificación (limpieza post-crecimiento)

Fecha: 2026-07-03
Estado: aprobado (diagnóstico + plan A/B/C), en implementación

## Contexto

El panel se armó de forma incremental agregando y quitando features. Quedó código
duplicado, secciones superpuestas y respuestas lentas. Se hizo una auditoría exhaustiva
(4 análisis paralelos: backend/rendimiento, peso frontend/duplicación, UX cliente, UX admin).
Este documento consolida el diagnóstico y el plan de trabajo por fases.

## Diagnóstico (por qué va lento / está mezclado)

**Lentitud — 4 causas reales (la base de datos NO es una de ellas; pesa ~1 KB):**
1. `loadAdminData` (index.html:3649) re-renderiza **8 secciones** en cada mutación
   (scan/bulk). Escanear 1 paquete repinta todo el panel, incluida la sección más cara
   (`renderPorCliente`).
2. Los handlers `await`ean el envío de email / llamada a 17track **antes** de responder.
   Peor caso: `PUT /api/admin/packages/bulk` (server.js:1315-1322) manda un mail por
   paquete, en serie, antes de contestar.
3. Bug de código muerto: el bloque lightbox (index.html:2414-2447) tiene un listener de
   `keydown` que hace `getElementById('lightbox')` (elemento inexistente) → **TypeError
   en cada tecla**.
4. Carga inicial: los ~314 KB del `index.html` (panel admin incluido) se bajan hasta para
   un visitante anónimo de la home.

**Superposición ("todo mezclado"):**
- Estado de paquete editable desde 6 pantallas; pagos desde 3; movimientos mostrados en 4.
- "Por cliente" (`renderPorCliente`) y "Todos los paquetes" (`renderAdminPackages`) son la
  misma lista con dos sistemas de selección paralelos (`selectedPkgs` vs `pcSelected`).
- Dos escáneres duplicados (`scanPkg`/`showScanMatches`/`scanFeedback` vs
  `pcScan`/`pcShowMatches`/`pcFeedback`).
- "No asignados" (`renderUnassigned`) e "Invitaciones" (`renderInvitaciones`) operan sobre
  la misma pila (`p.unassigned`).
- Menú admin de 12 items; objetivo ~7.

**Cliente:**
- Fecha de arribo/entrega solo se muestra en `estado === 'En tránsito'` (index.html:3020-3021,
  3126-3127) → desaparece al pasar a Clasificando/Listo, justo cuando el cliente más la quiere.
- 10 estados de badge (`ESTADO_INFO`) vs barra de 6 pasos (`PROG_STEPS`) → cartel y barra se
  contradicen ("En viaje" vs "En tránsito"; "En depósito" vs "Recibido en origen").
- Barra en celular: 6 puntos, solo 3 con label; el resto depende de `title` (no funciona en touch).
- Dos "saldo" con fuentes distintas (paquetes impagos vs movimientos) que pueden diferir.

**Seguridad (aparte, urgente):**
- `express.static(__dirname)` (server.js:30) sirve el repo entero → `GET /db.json` expone la
  base con contraseñas en texto plano. `.env` está oculto (dotfile), pero `db.json`, `server.js`,
  `package.json`, `deploy.sh`, `*.md` no.

## Plan por fases

Cada fase es independiente, se prueba local (node --check, boot+curl, E2E cuando aplica) y se
despliega verificando en vivo con curl. Rama por trabajo; no se pushea a GitHub (la contraseña
de `deploy.sh` sigue en texto plano — decisión previa del dueño).

### Fase A — Rápidas y seguras (bajo riesgo, alto impacto)

**A1. Seguridad — bloquear archivos sensibles.**
Middleware ANTES de `express.static` que devuelve 404 para una lista negra:
`db.json`, `server.js`, `package.json`, `package-lock.json`, `deploy.sh`, `*.md`, `docs/`, `*.backup`.
No se mueve el punto de entrada (Passenger). `manifest-core.js` DEBE seguir servido (el frontend
lo usa) → por eso lista negra por archivo, no por extensión.
*Fuera de alcance de A:* hashear contraseñas (rompería logins existentes; requiere migración; se
hace como tarea separada más adelante).

**A2. Borrar código muerto.**
- Bloque lightbox + listener keydown: index.html:2414-2447 (elimina el TypeError por tecla).
- `changeStatus` (index.html:3036) — sin call sites.
- `registrarPago` (index.html:3432) — superseded por `registrarRecibo`/`savePago`.
Verificar con grep de whole-word que cada uno no se llama en ningún lado antes de borrar.

**A3. Emails / 17track en segundo plano.**
Responder al cliente primero y disparar la notificación después (`res.json(...)` y luego
`sendX(...).catch(log)`), en: `POST /api/packages` (943), assign (989), status (1106),
admin update (1386), client-edit (1081), liquidación (1567), forgot-password (763), y el
**bulk** (1315-1322) — juntar los mails y mandarlos tras responder, en paralelo
(`Promise.allSettled`). Semántica: los mails son notificaciones, no parte de la respuesta.

**A4. Render selectivo + debounce.**
- `loadAdminData` (3649): re-renderizar solo la sección visible (según la sección activa de
  `showAdminSection`), no las 8. Mantener un helper que re-renderice la sección actual.
- Buscadores con `oninput` que hoy re-renderizan tablas completas (1768, 1871, 2041, 2022):
  envolver en debounce (~200 ms).

### Fase B — Experiencia del cliente

**B1. Fecha visible hasta el final.** Mostrar arribo/entrega estimada también en
`Clasificando en BsAs` y `Listo para entrega` (no solo `En tránsito`). En `Listo para entrega`,
mensaje "Coordinamos tu entrega" + CTA WhatsApp.

**B2. Unificar 10 estados → 6.** Colapsar a los 6 pasos canónicos de `PROG_STEPS` en todos lados
(badge y barra usan la misma palabra). Retirar/mapear "En depósito"→"Recibido en origen",
"En viaje"→"En tránsito", y "Pendiente". Mantener "Retenido" como estado especial fuera de la barra.
Definir el mapa único y aplicarlo en `statusBadge`, `progressBar` y el backend donde se setean estados.

**B3. Celular + saldo único.** Bajo ~700px, render de paquetes como tarjetas apiladas (sin scroll
lateral); label del paso actual en palabras bajo la barra. Un solo cálculo de saldo (una fuente de
verdad) usado en Resumen, Balance y Cta Cte. Quitar el `padding-top:104px` muerto del dashboard móvil
(index.html:757) tras verificar en teléfono.

### Fase C — Simplificar el panel (más grande, con cuidado)

**C1. Paquetes + Por cliente → una sola vista** con toggle "Agrupar por cliente"; un solo sistema de
selección; el botón "Liquidar" vive en el encabezado del grupo de cliente.

**C2. Un solo escáner/recepción** con dropdown "Estado al escanear" (Recibir / En tránsito /
Clasificar / Listo) y toggle "agrupar por cliente". Extraer un `resolveScan()` y un selector de
coincidencias únicos.

**C3. Un solo "Sin dueño"** (fusiona No asignados + Invitaciones): cada fila con "Asignar a cliente ▾"
y "Invitar por WhatsApp".

**C4. Una sola "Cuenta corriente"** (fusiona Recibos + Cta Cte + Liquidaciones) con pestañas de filtro
(Todos / Pagos / Liquidaciones) y selector de cliente. Un solo renderer de movimientos.

Objetivo de nav: 12 → ~7 items.

## Verificación (todas las fases)

- `node --check server.js`; sintaxis de bloques inline de index.html vía `vm.Script`.
- Boot local + curl a endpoints tocados.
- E2E en Chrome real donde el flujo lo amerite (login cliente, invitación, escaneo).
- Deploy con `deploy.sh` y verificación EN VIVO con curl (deploy.sh imprime ✓ aunque falle).
- Nada destructivo sobre datos; cambios reversibles por fase.

## Riesgos

- No romper logins: NO hashear contraseñas en Fase A.
- Emails async: no perder notificaciones (log de errores; el flujo de negocio no depende de que el
  mail salga en la misma request).
- Refactor de estados (B2) y de secciones (C): alto riesgo de regresión visual — revisión por
  subagente (spec + calidad) y verificación E2E antes de cada deploy.
- Seguridad A1: no bloquear de más (que `manifest-core.js`, imágenes, videos y las páginas legales
  `.html` sigan accesibles).
