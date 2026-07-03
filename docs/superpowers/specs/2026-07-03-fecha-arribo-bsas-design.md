# Fecha de arribo estimado a BsAs (manual)

Fecha: 2026-07-03
Estado: aprobado (diseño), pendiente de implementación

## Objetivo

Al procesar un manifiesto, permitir que el admin cargue **manualmente** una fecha de
**arribo estimado a Buenos Aires** (una por manifiesto). De esa fecha se **deriva
automáticamente** la entrega estimada como **arribo + 2 días**. Ambas se muestran al
cliente en su panel y se incluyen en el email de "En tránsito" que ya se envía.

Reemplaza (para paquetes de manifiesto) el cálculo actual de entrega estimada de
"+5 días desde En tránsito" por uno basado en un dato real.

## Alcance

**Incluye:**
- Campo de fecha "Arribo estimado a BsAs" en la sección "Procesar manifiesto" (opcional).
- Al aplicar, guardar en los paquetes procesados (los que pasan a "En tránsito" + los
  que se crean): `fechaArriboBsAs` (= lo cargado) y `fechaEstimadaEntrega` (= arribo + 2 días).
- Mostrar ambas fechas en el panel del cliente (card + detalle), redactadas como estimadas.
- Incluir ambas fechas en el email de cambio a "En tránsito" (cuando existan).

**Fuera de alcance:**
- Editar la fecha después (se recarga procesando de nuevo, o edición manual del paquete — no v1).
- Notificar cuando la fecha cambia.
- Esconder la "Entrega estimada" automática de otros flujos.

## Comportamiento

- La fecha es **una por manifiesto** (aplica a todos los paquetes de esa subida que se procesan).
- Es **opcional**: si el admin no la carga, el flujo queda igual que hoy (el fallback +5 sigue vigente).
- **Fallback intacto:** `applyETA` (que pone `fechaEstimadaEntrega` = En tránsito + 5 días) se
  mantiene como está. Cuando el manifiesto trae fecha de arribo, se **sobrescribe** con arribo + 2.
  Paquetes que llegan a "En tránsito" por otros flujos siguen usando el +5.

## Cambios

### Frontend (`index.html`)
1. Sección "Procesar manifiesto": `<input type="date" id="manif-arribo">` con label "Arribo estimado a BsAs (opcional)".
2. `manifConfirmApply()`:
   - Lee la fecha del input. Si está cargada, calcula `entrega = arribo + 2 días`.
   - En el PUT bulk (transit): agrega `fields.fechaArriboBsAs` y `fields.fechaEstimadaEntrega`.
   - En el POST ingest (creados): agrega `fechaArriboBsAs` y `fechaEstimadaEntrega` a cada item.
   - Si no hay fecha, no agrega esos campos (comportamiento actual).
3. Panel del cliente: donde hoy se muestra "Entrega estimada" (`renderPackages` ~L2991,
   `renderPackageDetail` ~L3095, y la vista admin ~L3824), agregar una línea
   "Arribo estimado a BsAs: X (puede variar)" cuando `p.fechaArriboBsAs` exista.
   La entrega estimada ya se muestra; con este cambio refleja arribo + 2.

### Backend (`server.js`)
1. Bulk (`allowed` en `PUT /api/admin/packages/bulk`, L1255): agregar
   `'fechaArriboBsAs'` y `'fechaEstimadaEntrega'` a la lista de campos permitidos.
   (Idem edición individual L1311, por consistencia.)
2. `POST /api/admin/packages/ingest`: aceptar `fechaArriboBsAs` y `fechaEstimadaEntrega`
   por item y guardarlos en el paquete creado (si vienen).
3. `sendStatusChangeEmail`: si `pkg.fechaArriboBsAs` existe, incluir en el cuerpo
   "Arribo estimado a BsAs: X" y "Entrega estimada: Y" (Y = `pkg.fechaEstimadaEntrega`).

## Datos

- Campos nuevos en el paquete: `fechaArriboBsAs` (string 'YYYY-MM-DD'), y se reusa el
  existente `fechaEstimadaEntrega`. Sin migración (campos opcionales).

## Verificación

- El cálculo arribo + 2 días se prueba en aislamiento (función pura de fecha).
- Integración: login + ingest con fechas → el paquete queda con ambas fechas correctas.
- Bulk: PUT con las fechas → se persisten.
- Sintaxis (`node --check`, bloques inline) y arranque del server.
- Verificación visual del panel del cliente (mostrar arribo cuando existe).
- Nada destructivo; campos opcionales; sin migración.

## Riesgos

- Zona horaria en el cálculo +2 días: usar aritmética de fecha simple sobre 'YYYY-MM-DD'
  para evitar corrimientos por timezone.
- No romper el fallback +5 (se mantiene `applyETA` intacto).
