# Procesar Manifiesto — Fase 1 (Ingestión)

Fecha: 2026-07-02
Estado: propuesta para revisión

## 1. Contexto y objetivo

Los manifiestos de ALAN (el forwarder en origen) llegan por email como **PDF digital** y listan la carga despachada: por caja, cada paquete con `Cliente · Nº de rastreo · Kilos`. Hoy esa información se procesa a mano.

Objetivo de la Fase 1: un **botón en el panel admin** que, al subir uno o varios PDF de manifiesto, en una sola pasada:

1. **Consolida** los paquetes agrupados por cliente y genera **PDF + Excel**.
2. **Matchea** los rastreos contra la base y pasa a **"En tránsito"** los paquetes que ya existen (notificando al cliente).
3. **Auto-crea** los paquetes que faltan (asignados por nombre, o a "por asignar"), para dejar de depender de que el cliente los cargue.

Todo pasa por una **vista previa con confirmación** antes de tocar datos o mandar emails.

Problema de fondo que resuelve: hoy solo ~10% de los paquetes del manifiesto están en el sistema (los clientes no cargan sus paquetes). Auto-crearlos lleva la cobertura a ~100% sin depender de terceros.

## 2. Alcance

**Incluye (Fase 1):**
- Parseo de manifiestos en **PDF digital** (formato ALAN, como 19.6 / 22.6).
- Consolidado PDF + Excel (idéntico al ya validado, agrupado por cliente con subtotales y total).
- Matcheo por sufijo → cambio a "En tránsito" de los paquetes existentes.
- Auto-creación de los paquetes faltantes.
- Vista previa + confirmación obligatoria.

**Fuera de alcance (otras fases):**
- **Invitaciones** a clientes ("tus paquetes ya están cargados") → Fase 2.
- Gestión de contactos (WhatsApp/email de clientes no registrados) → Fase 2.
- Registro sin fricción (magic link / OTP) → Fase 3 (opcional).
- **Manifiestos manuscritos** (fotos, como la caja 4302): no se parsean automático; se cargan a mano.
- Consolidado **acumulativo/histórico**: la Fase 1 es **por lote** (procesa lo que se sube, sin persistir el consolidado).
- Anotaciones por paquete tipo "en Miami" (manuales).

## 3. Arquitectura

- **Frontend (navegador), dentro del panel admin** (`index.html`): parseo del PDF con **pdf.js** (CDN, igual patrón que la lib de QR), lógica de matcheo/consolidación en JS, generación de **PDF** con el enfoque de impresión ya usado y **Excel** con **SheetJS** (CDN).
- **Backend (`server.js`)**: se **reusa** lo existente y se agrega **un solo endpoint** para el alta batch de faltantes.

Motivo: mantener consistencia con lo que ya hace la app (genera PDFs client-side, carga libs por CDN) y esquivar limitaciones del hosting compartido (sin Python/poppler).

## 4. Flujo de usuario

```
[Panel admin] → botón "Procesar manifiesto"
   → subir 1..N PDF
   → (navegador) parsea + matchea + arma el plan
   → VISTA PREVIA:
       • Consolidado (clientes, paquetes, kg, total)
       • Nombres detectados / alias a confirmar
       • Plan de estados:
           ✅ Matcheados → pasan a "En tránsito" (con email)
           🆕 A crear (asignados a cliente) → "En tránsito", sin email
           📥 A crear (por asignar) → "En tránsito", bandeja no asignados
           ⚠️ Ambiguos (sufijo matchea 2+) → NO se tocan, requieren decisión
           ⏭️ Ya avanzados (Entregado/Listo/…) → se saltean
   → [Confirmar y aplicar]  |  [Solo generar documentos]  |  [Cancelar]
   → al confirmar: aplica cambios + genera PDF/Excel + muestra resumen
```

## 5. Componentes

### 5.1 Parser de PDF (pdf.js)
- Extrae texto por página con `getTextContent()`; reconstruye **líneas por coordenada Y** y ordena por X.
- Une los ítems de una línea con separación **por posición** (si el hueco al siguiente ítem supera ~0.25× la altura de fuente, inserta espacio).
- Reglas de parseo (portadas del parser Python ya validado):
  - Se ignoran encabezados (`Nº Cliente…`), cajas (`CAJA…`, `ALAN…`, `…KGS`, `TOTAL…`) y enteros sueltos (redondeos/paginado).
  - Una **fila de datos** contiene un kilo decimal `\d+\.\d+`. El primer decimal es el **peso**; el entero posterior (redondeo) se ignora.
  - Cliente/tracking: se saca el `Nº` inicial **solo** si lo sigue un cliente alfabético (formato inline); en el formato partido, la línea es `<tracking> kilos` y el cliente viene de la línea previa. Los tokens alfabéticos iniciales son el cliente; el resto, el tracking (puede ser vacío o `2 PCS`).
- **Validación de completitud**: la suma de kilos parseados debe coincidir con la suma independiente de decimales del PDF (excluyendo cajas). Si no coincide, se avisa en la preview.

> Limitación conocida: en PDFs con "letter-spacing" (como el 22.6), los **nombres de cliente** pueden salir partidos ("CALDERO NE"). Se resuelve con el **mapa de alias** (5.6) + la confirmación en la preview. Los **números** (rastreo/kilos) salen limpios.

### 5.2 Consolidación
- Agrupa por cliente **canonizado** (alias, 5.6), ordena alfabéticamente; dentro de cada cliente por manifiesto+tracking.
- Salida:
  - **PDF**: encabezado por cliente, tabla `Nº · Manifiesto · Rastreo · Kg`, subtotal por cliente, TOTAL GENERAL. Mismo estilo Arbox ya aprobado.
  - **Excel** (SheetJS): hoja **Consolidado** (agrupado, con subtotales/total como fórmulas) + hoja **Detalle** (plana, filtrable).

### 5.3 Matcheo por sufijo → "En tránsito"
- Fuente: `GET /api/admin/packages` (ya cargado en `adminPackages`).
- Normalización: mayúsculas, sin espacios.
- Regla (verificada con datos reales): el rastreo del manifiesto es el **sufijo** del ID completo en la base.
  1. **Exacto** (`id === rastreo`).
  2. **Sufijo único** (`id.endsWith(rastreo)` y matchea exactamente 1 paquete).
  3. Si matchea **2+** → **ambiguo** (no se toca).
  4. Si **0** → candidato a auto-creación (5.4).
- A los matcheados **existentes**:
  - Si su estado actual es **anterior** a "En tránsito" (`Registrado`, `Recibido en origen`, `En depósito`) → se marcan **"En tránsito"** vía `PUT /api/admin/packages/bulk` (dispara el email de cambio de estado — deseado).
  - Si ya están en "En tránsito" o **más avanzados** (`Clasificando en BsAs`, `Listo para entrega`, `Entregado`, `Retenido`) → **se saltean** (no se retrocede), se muestran como info.

### 5.4 Auto-creación de faltantes
- Para cada rastreo **sin match** en la base:
  - **Asignación por nombre**: se busca el cliente por el apellido canónico del manifiesto como **token completo** dentro del nombre del cliente en la base (case-insensitive).
    - Exactamente **1** cliente → se crea **asignado** a ese cliente.
    - **0** o **2+** clientes → se crea **"por asignar"** (bandeja no asignados), para que el admin lo resuelva.
  - Estado inicial: **"En tránsito"** (viene en un manifiesto de salida).
  - **Sin email** (los auto-creados no notifican; la comunicación va en la Fase 2 con la invitación).
  - Campos: `id`=rastreo, `peso` del manifiesto, `desc` genérica (p. ej. "Paquete en tránsito (manifiesto)"), `deposito` por defecto `'Miami'` (ajustable en la preview), historial inicial `En tránsito`.
  - **Duplicados**: si el `id` ya existe (carrera con el matcheo), se omite la creación y cae en el flujo de matcheo.

### 5.5 Vista previa / confirmación
- Tabla-resumen con contadores por categoría (consolidado / matcheados / a crear asignados / a crear por asignar / ambiguos / ya avanzados).
- Permite **corregir/agrupar nombres** (alias) antes de aplicar, precargado con los alias ya acordados.
- Permite **destildar** filas puntuales (que un match dudoso no se aplique).
- Dos acciones separadas: **"Solo generar documentos"** (no toca datos) y **"Confirmar y aplicar"** (cambia estados + crea + genera documentos).
- Nada se ejecuta sin confirmación explícita (cambia datos y **dispara emails**).

### 5.6 Mapa de alias
- Objeto normalizador semilla (business + artefactos de extracción):
  - `VALERIA CALDERON`, `CALDERO NE` → `CALDERONE`
  - `SCONF`, `SCO NF`, `SCO NFIETTI` → `SCONFIETTI`
  - `MIGUES` → `MIGUEZ`
  - `CACOPARDO`, `CACO PARDO`, `MONICA CACOPAR` → `CALOPARDO`
  - `ELI` → `ELIANA`
  - `AMALGAM`, `MALDONADO`, `DANIEL MALDONADO`, `MENCONI` → `AMALGAM/MALDONADO/MENCONI`
- **Persistencia en `localStorage`** del navegador: crece con el tiempo sin depender de despliegues. (Editable desde la preview.)

## 6. Backend

**Reuso:**
- `GET /api/admin/packages` — para matchear.
- `PUT /api/admin/packages/bulk` — para pasar matcheados a "En tránsito" (con email de cambio de estado).

**Nuevo (único agregado):**
- `POST /api/admin/packages/ingest` (requireAdmin): recibe una lista de paquetes a crear
  `[{ id, clientId|null, peso, deposito, desc, estado:'En tránsito' }]`.
  - Crea cada uno **si el id no existe** (si existe, lo omite y lo reporta).
  - Setea el estado indicado con historial inicial correspondiente.
  - **No envía emails** (a diferencia de `/assign` y `/bulk`).
  - Devuelve resumen `{ creados, omitidos, errores }`.
  - Motivo de endpoint nuevo: los existentes fuerzan estado ('Registrado' / 'Recibido en origen') y/o mandan email; acá necesito estado 'En tránsito' controlado y **sin notificación**.

## 7. Reglas y casos borde (resumen)

| Situación | Comportamiento |
|---|---|
| Rastreo matchea 1 paquete, estado anterior | → "En tránsito" (con email) |
| Rastreo matchea 1 paquete, ya avanzado | Se saltea (no retrocede) |
| Rastreo matchea 2+ paquetes (sufijo) | Ambiguo: no se toca, se muestra para decisión |
| Rastreo sin match, 1 cliente por nombre | Se crea asignado, "En tránsito", sin email |
| Rastreo sin match, 0 o 2+ clientes | Se crea "por asignar", "En tránsito" |
| Fila sin tracking (caja grande sin rastreo) | Entra al consolidado; no se puede matchear/crear con id → se lista aparte como "sin rastreo" |
| Nombre partido por extracción (22.6) | Se normaliza por alias; si es desconocido, se resalta en la preview |
| Suma de kilos ≠ suma independiente del PDF | Aviso en la preview (posible fila mal leída) |
| PDF manuscrito / sin capa de texto | Se detecta (0 filas parseadas) y se avisa: cargar a mano |

## 8. Limitaciones honestas
- Solo PDF **digitales** con capa de texto; los manuscritos no.
- La **cobertura de matcheo** depende de qué paquetes están registrados; el resto se **crea** (por eso este enfoque), pero los creados "por asignar" requieren que el admin los enlace a un cliente.
- El matcheo por sufijo con códigos cortos puede colisionar → por eso los ambiguos **no** se aplican solos.
- Los nombres del 22.6 pueden requerir un toque manual en la preview la primera vez (después quedan en el alias map).

## 9. Validación / pruebas
- Parser JS (pdf.js) validado contra los 2 manifiestos reales (19.6 y 22.6): debe reproducir los **213 paquetes / 704.28 kg** y la validación de completitud.
- Matcheo por sufijo validado contra un snapshot **read-only** de la base (sin escribir).
- Prueba del endpoint `ingest` en local (arranque del server + alta de prueba) antes de desplegar.
- Verificación post-deploy contra el sitio en vivo (ruta registrada, sin romper arranque).
- Nada destructivo: creación idempotente por `id`, y la confirmación humana como última barrera.

## 10. Riesgos
- **Emails erróneos** por match dudoso → mitigado por confirmación + no-aplicar ambiguos + no-email en auto-creados.
- **Mis-asignación por nombre** → solo se asigna con 1 match exacto de token; el resto va a "por asignar".
- **Extracción imperfecta (22.6)** → alias map + preview.
- **Cambios en producción** → endpoint nuevo aislado, idempotente, y validación de arranque antes de desplegar.
