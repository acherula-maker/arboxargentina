# Vista "Paquetes por cliente" con escaneo de clasificación

**Fecha:** 2026-06-10
**Archivo afectado:** `index.html` (solo frontend, sin cambios de backend)

## Problema

El escáner actual del panel admin agrega los trackings a una lista plana, sin
separar por cliente. Cuando llega un envío consolidado a Buenos Aires, el
operador separa físicamente la mercadería por cliente y quiere escanear toda la
pila de un cliente "junta", verificando que estén todos los paquetes de ese
cliente y dejándolos listos para liquidar.

## Solución

Nueva sección en el panel admin: **"Paquetes por cliente"**, que muestra todos
los paquetes agrupados por cliente y permite escanear desde ahí. Cada escaneo
pasa el paquete al estado elegido (por defecto **"Clasificando en BsAs"**), que
es el estado que habilita la liquidación.

### Componentes

1. **Ítem de navegación** — `📋 Por cliente` en el sidebar admin, bajo *Principal*,
   junto al Escáner. Llama `showAdminSection('por-cliente', this)`.

2. **Barra de escaneo (fija arriba, fuera del contenedor que se re-renderiza)**
   - Input de tracking + botón "Marcar".
   - Selector de estado destino, por defecto `Clasificando en BsAs`.
   - Auto-rutea: un tracking pertenece a un único cliente, así que no hay que
     elegir cliente antes. Se mantiene un solo input para no perder foco con la
     pistola.
   - Lógica `pcScan()`: busca el tracking en `adminPackages`.
     - 1 match → aplica el estado destino vía `PUT /api/admin/packages/bulk`
       (que ya agrega historial y manda el email al cliente), muestra feedback y
       re-renderiza.
     - varios matches → dropdown de selección (mismo patrón que el escáner actual).
     - sin match → aviso.

3. **Lista agrupada por cliente** (`renderPorCliente()` → `#pc-groups`)
   - Una tarjeta por cliente con paquetes (orden alfabético; los que tienen
     paquetes pendientes del estado destino primero).
   - Header: nombre · N paquetes · contador "X/Y en <estado destino>" · saldo ·
     botón `📦 Liquidar` (abre el modal existente `openLiquidacion`).
   - Tabla: checkbox, tracking, descripción, depósito, estado (badge), peso.
     Las filas ya en el estado destino se ven resaltadas en verde.
   - Barra de acción en bloque por cliente: seleccionar todos + cambiar estado de
     los seleccionados (`pcApplyClientBulk`).
   - Filtro de texto (cliente o tracking) y toggle "mostrar entregados"
     (por defecto ocultos).

4. **Sincronización** — `renderPorCliente()` se agrega a `loadAdminData()` para
   que la vista quede al día después de cada escaneo/acción.

### Estado / selección
- Selección de paquetes en un `Set` global `pcSelected` (mismo patrón que
  `selectedPkgs` en "Todos los paquetes"). Los checkboxes reflejan el set tras
  cada re-render.

## Fuera de alcance (YAGNI)
- "Modo cliente" que bloquee a un cliente y avise si escaneás un paquete de otro:
  no se implementa en v1 (se eligió escáner único auto-ruteado).
- Cambios de backend: ninguno. Se reutiliza el endpoint bulk existente.
