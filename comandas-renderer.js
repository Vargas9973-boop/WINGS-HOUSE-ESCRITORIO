// ==========================================================================
// ESTADO
// ==========================================================================
let session = null;
let allProducts = [];
let allPromotions = [];
let catalogLoaded = false;
let currentTableNumber = null;
let currentSaleId = null;
let currentOrderMode = null; // 'mesa' | 'llevar'
let currentItems = [];
let selectedCategory = 'all';
let selectedPayMethod = 'efectivo';
let productAvailability = {}; // productId -> { status: 'rojo'|'amarillo'|'verde', shortInsumo, maxSellable } -- ver computeProductAvailability()
let productModifierGroupsByProduct = new Map(); // productId -> Map(group_name -> qty), p.ej. 4 -> Map([['Salsas', 1]]); un combo puede pedir qty=2
let promotionModifierGroupsByPromotion = new Map(); // mismo shape que arriba, pero por promotion_id (tabla propia, ver 20260901000000_promotion_modifier_groups.sql)
let cachedSauceModifiers = null; // caché de window.db.modifiers.list('Salsas') -- ver showSauceSelector()

// Semáforo de disponibilidad por producto a partir de recipes+inventory
// (window.db.recipes.getAllWithStock). Copia de la versión en common.js:
// esta se agregó antes de que comandas.html incluyera common.js (ahora sí
// lo incluye, para los atajos de teclado -- ver el final de este archivo),
// pero se deja así para no arriesgar el flujo de venta cambiando cuál de
// las dos gana.
function computeProductAvailability(recipesRaw) {
  const byProduct = {};
  (recipesRaw || []).forEach((r) => {
    const inv = r.inventory;
    if (!inv) return;
    if (!byProduct[r.product_id]) byProduct[r.product_id] = [];
    byProduct[r.product_id].push({
      insumoId: inv.id,
      name: inv.name,
      unit: inv.unit,
      stock: Number(inv.stock) || 0,
      minStock: Number(inv.min_stock) || 0,
      needed: Number(r.quantity_needed) || 0
    });
  });

  const result = {};
  Object.keys(byProduct).forEach((pid) => {
    const rows = byProduct[pid];
    let status = 'verde';
    let shortInsumo = null;
    let maxSellable = Infinity;
    rows.forEach((row) => {
      if (row.needed > 0) maxSellable = Math.min(maxSellable, Math.floor(row.stock / row.needed));
      if (row.stock < row.needed) {
        status = 'rojo';
        if (!shortInsumo) shortInsumo = row;
      } else if (status !== 'rojo' && row.stock <= row.minStock) {
        status = 'amarillo';
      }
    });
    result[pid] = { status, shortInsumo, maxSellable: maxSellable === Infinity ? null : maxSellable };
  });
  return result;
}

async function refreshAvailability() {
  try {
    const recipesRaw = await window.db.recipes.getAllWithStock();
    productAvailability = computeProductAvailability(recipesRaw);
    renderProducts();
  } catch (err) {
    console.error('No se pudo actualizar la disponibilidad de insumos:', err);
  }
}

// ==========================================================================
// ACTUALIZACIÓN AUTOMÁTICA
// ==========================================================================
// Intervalos únicos para evitar que se creen varios al entrar/salir de mesas.
let tablesRefreshInterval = null;
let orderRefreshInterval = null;

// Intervalo de actualización automática.
// 3000 = 3 segundos.
const AUTO_REFRESH_MS = 3000;

// ==========================================================================
// ALERTA DE COCINA — polling de respaldo (fallback)
// ==========================================================================
// Realtime (Supabase) es la vía principal para avisar de comandas nuevas.
// Este polling NO reemplaza esa vía: solo se activa cuando Realtime está
// caído (isRealtimeConnected === false), para que la alerta de cocina siga
// funcionando aunque se pierda la conexión websocket.
let isRealtimeConnected = false;
let fallbackAlertInterval = null;
// IDs de venta ya notificados (por Realtime o por este mismo polling), para
// no volver a reportarlos si el polling los vuelve a encontrar.
const notifiedSaleIds = new Set();

async function fetchComandas() {
  if (isRealtimeConnected) return; // Realtime activo: el polling de respaldo no aplica.

  try {
    const [tables, takeoutOrders] = await Promise.all([
      window.comandasAPI.getTables(),
      window.comandasAPI.getTakeoutOrders()
    ]);

    tables.forEach((t) => {
      if (t.status !== 'ocupada' || t.saleId == null) return;

      if (notifiedSaleIds.has(t.saleId)) {
        console.log('🔕 Ignorado duplicado:', t.saleId);
        return;
      }

      notifiedSaleIds.add(t.saleId);

      if (window.orderAlertAPI) {
        window.orderAlertAPI.reportFallbackSale({
          id: t.saleId,
          table_number: t.number,
          total: t.total
        });
      }
    });

    (takeoutOrders || []).forEach((o) => {
      if (notifiedSaleIds.has(o.id)) {
        console.log('🔕 Ignorado duplicado:', o.id);
        return;
      }

      notifiedSaleIds.add(o.id);

      if (window.orderAlertAPI) {
        window.orderAlertAPI.reportFallbackSale({
          id: o.id,
          table_number: null,
          total: o.total
        });
      }
    });
  } catch (err) {
    console.error('Error en el polling de respaldo de comandas:', err);
  }
}

function startFallbackAlertPolling() {
  stopFallbackAlertPolling();
  fallbackAlertInterval = setInterval(fetchComandas, AUTO_REFRESH_MS);
}

function stopFallbackAlertPolling() {
  if (fallbackAlertInterval) {
    clearInterval(fallbackAlertInterval);
    fallbackAlertInterval = null;
  }
}

function updateRealtimeBadge(connected) {
  const badge = document.getElementById('realtime-status');
  if (!badge) return;
  badge.textContent = connected ? 'Conectado' : 'Desconectado';
  badge.classList.toggle('realtime-connected', connected);
  badge.classList.toggle('realtime-disconnected', !connected);
}

function applyRealtimeStatus(connected) {
  isRealtimeConnected = connected;
  updateRealtimeBadge(connected);

  if (connected) {
    // Realtime está al mando: se detiene el polling de respaldo.
    stopFallbackAlertPolling();
  } else {
    // Realtime caído: el polling de respaldo toma el control cada 3s.
    fetchComandas();
    startFallbackAlertPolling();
  }
}

if (window.orderAlertAPI) {
  window.orderAlertAPI.onStatus((connected) => applyRealtimeStatus(connected));
  window.orderAlertAPI.onNewSale((saleId) => notifiedSaleIds.add(saleId));
}

const tablesScreen = document.getElementById('tables-screen');
const orderScreen = document.getElementById('order-screen');
const tablesGrid = document.getElementById('tables-grid');
const takeoutGrid = document.getElementById('takeout-grid');
const cartHeaderTitle = document.getElementById('cart-header-title');
const btnCancelTable = document.getElementById('btn-cancel-table');
const btnPrintKitchen = document.getElementById('btn-print-kitchen');
const productsGrid = document.getElementById('products-grid');
const promoStrip = document.getElementById('promo-strip');
const cartItemsContainer = document.getElementById('cart-items');
const totalEl = document.getElementById('total-amount');
const searchInput = document.getElementById('search-input');
const checkoutModal = document.getElementById('checkout-modal');
const checkoutTotalAmount = document.getElementById('checkout-total-amount');
const cashFields = document.getElementById('cash-fields');
const amountReceivedInput = document.getElementById('amount-received');
const changeAmountEl = document.getElementById('change-amount');
const chkPrint = document.getElementById('chk-print');

// ==========================================================================
// UTILIDADES
// ==========================================================================

function fmt(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&',
    '<': '<',
    '>': '>',
    '"': '"',
    "'": "'"
  }[c]));
}

function toast(message, type = 'default') {
  let container = document.getElementById('toast-container');

  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;

  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease';

    setTimeout(() => el.remove(), 300);
  }, 3000);
}

// Revisa insumos en/bajo su stock mínimo después de cobrar una venta y
// avisa con un toast rojo por cada uno (igual que la alerta de stock de
// productos que ya existe en el carrito).
async function alertLowStockInsumos() {
  try {
    const lowStock = await window.db.inventory.checkLowStock();
    lowStock.forEach((item) => {
      toast(`Stock bajo: ${item.name} — ${item.stock} ${item.unit || ''} restantes`, 'error');
    });
  } catch (err) {
    console.error('No se pudo revisar el stock mínimo de insumos:', err);
  }
}

// ==========================================================================
// AVISO "ORDEN LISTA" (KDS -> caja/mesero) — ver kds/kds-renderer.js. Cocina
// marca la orden 'lista' en la TV; main.js detecta la transición por
// Realtime y la manda aquí para no depender de que alguien vaya a ver el
// KDS físicamente.
// ==========================================================================
function playKdsReadyChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.5, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.4);
  } catch (err) {
    console.error('No se pudo reproducir el aviso de orden lista:', err);
  }
}

if (window.kdsReadyAPI) {
  window.kdsReadyAPI.onReady((info) => {
    const label = info.tableNumber ? `Mesa ${info.tableNumber}` : info.folio ? `folio ${info.folio}` : `#${info.id}`;
    toast(`¡Orden ${label} lista para entregar!`, 'success');
    playKdsReadyChime();
  });
}

// ==========================================================================
// MAPA DE MESAS
// ==========================================================================

async function loadTables() {
  try {
    const tables = await window.comandasAPI.getTables();

    // Si por alguna razón el usuario ya salió del mapa,
    // no necesitamos volver a pintarlo.
    if (!tablesGrid) return;

    tablesGrid.innerHTML = tables
      .map(
        (t) => `
          <div class="table-card ${t.status}" data-table="${t.number}">
            <h3>Mesa ${t.number}</h3>
            <span class="status-label">
              ${t.status === 'libre' ? 'Libre' : 'Ocupada'}
            </span>
            ${
              t.status === 'ocupada'
                ? `<div class="table-total">${fmt(t.total)}</div>`
                : ''
            }
          </div>
        `
      )
      .join('');

    tablesGrid.querySelectorAll('.table-card').forEach((card) => {
      card.addEventListener('click', () => {
        openTableScreen(Number(card.dataset.table));
      });
    });
  } catch (err) {
    console.error('Error al cargar las mesas:', err);
  }
}

// ==========================================================================
// PEDIDOS PARA LLEVAR
// ==========================================================================
// A diferencia de una mesa (una comanda abierta a la vez, reutilizada por
// número), un pedido para llevar es una comanda nueva cada vez: puede haber
// varios en curso simultáneamente, así que se listan por id.

function deliveryStatusLabel(status) {
  return {
    pendiente: 'Pendiente',
    en_camino: 'En camino',
    entregado: 'Entregado'
  }[status] || 'Pendiente';
}

// Copia local de la última carga: openAssignDriverModal la usa para
// precargar el envío/total del pedido sin volver a pedirlo al abrir el modal.
let latestTakeoutOrders = [];

// Un domicilio tiene dos estados independientes:
//   delivery_status -> dónde va el pedido (pendiente/en_camino/entregado)
//   payment_status  -> dónde está el dinero (pendiente/dinero_con_repartidor/liquidado)
// Antes de asignar repartidor (comandaAssignDriver, ver
// migración 20260819050000) no se puede pasar a "en camino": el botón
// "En camino" de antes se reemplaza por "Asignar repartidor y enviar", que
// hace las dos cosas en una sola acción. El dinero solo pasa a estar "con el
// repartidor" hasta que se marca Entregado (ahí es cuando de verdad cobra en
// la puerta); mientras tanto solo se anuncia cuánto va a cobrar.
function deliveryCardHtml(o) {
  const status = o.delivery_status || 'pendiente';
  const hasDriver = !!o.driver_id;
  const total = Number(o.total) || 0;
  const fee = Number(o.delivery_fee) || 0;
  const foodTotal = Math.max(total - fee, 0);

  let moneyLine = '';
  if (o.payment_status === 'dinero_con_repartidor') {
    moneyLine = `<div class="delivery-money">💰 Cobró ${fmt(total)} — debe regresar ${fmt(foodTotal)} (liquidar en Ajustes → Repartidores)</div>`;
  } else if (hasDriver && status !== 'entregado') {
    moneyLine = `<div class="delivery-info delivery-pending-driver">Va a cobrar ${fmt(total)} en la puerta (envío ${fmt(fee)} para el repartidor)</div>`;
  }

  let actionsHtml = '';
  if (!hasDriver) {
    actionsHtml = `<button type="button" class="btn-delivery-status" data-action="assign-driver" data-sale-id="${o.id}">🛵 Asignar repartidor y enviar</button>`;
  } else if (status !== 'entregado') {
    actionsHtml = `<button type="button" class="btn-delivery-status" data-action="entregado" data-sale-id="${o.id}">✅ Marcó llegada - Entregada</button>`;
  }

  return `
    <div class="table-card takeout-card delivery-card" data-sale-id="${o.id}">
      <h3>🛵 #${o.id}</h3>
      <span class="status-label">${hasDriver ? deliveryStatusLabel(status) : 'DOMICILIO - POR ASIGNAR'}</span>
      <div class="delivery-info">
        <div class="delivery-address">${escapeHtml(o.delivery_address || 'Sin dirección')}</div>
        ${o.customer_name ? `<div class="delivery-customer">${escapeHtml(o.customer_name)}</div>` : ''}
        <div class="delivery-driver">
          ${o.driver_name ? `Repartidor: ${escapeHtml(o.driver_name)}` : 'Sin repartidor asignado'}
        </div>
      </div>
      ${moneyLine}
      <div class="table-total">${fmt(o.total)}</div>
      <div class="delivery-actions">${actionsHtml}</div>
    </div>
  `;
}

async function handleSetDeliveryStatus(saleId, status) {
  try {
    await window.comandasAPI.setDeliveryStatus(saleId, status);
    await loadTakeoutOrders();
  } catch (err) {
    console.error('Error al actualizar el estado de entrega:', err);
    toast(
      err && err.message ? err.message : 'No se pudo actualizar el estado de entrega.',
      'error'
    );
  }
}

// ==========================================================================
// ASIGNAR REPARTIDOR (domicilio) — modal
// ==========================================================================
const assignDriverModal = document.getElementById('assign-driver-modal');
const assignDriverSelect = document.getElementById('assign-driver-select');
const assignDriverFeeInput = document.getElementById('assign-driver-fee');
const assignDriverBreakdown = document.getElementById('assign-driver-breakdown');
let assignDriverSaleId = null;

function renderAssignDriverBreakdown() {
  const order = latestTakeoutOrders.find((o) => o.id === assignDriverSaleId);
  if (!order || !assignDriverBreakdown) return;

  const fee = Number(assignDriverFeeInput.value) || 0;
  const existingTotal = Number(order.total) || 0;
  const existingFee = Number(order.delivery_fee) || 0;
  // El total del pedido ya puede traer un envío cargado desde la web
  // (comanda_set_delivery); aquí solo se ajusta por la diferencia, igual
  // que hace comanda_assign_driver en la base de datos.
  const foodTotal = Math.max(existingTotal - existingFee, 0);
  const newTotal = foodTotal + fee;

  assignDriverBreakdown.innerHTML = `
    <div class="breakdown-row"><span>Total comida</span><span>${fmt(foodTotal)}</span></div>
    <div class="breakdown-row"><span>Envío</span><span>${fmt(fee)}</span></div>
    <div class="breakdown-row highlight"><span>Total a cobrar en domicilio</span><span>${fmt(newTotal)}</span></div>
    <div class="breakdown-row"><span>Repartidor se queda</span><span>${fmt(fee)}</span></div>
    <div class="breakdown-row"><span>Debe regresar al local</span><span>${fmt(foodTotal)}</span></div>
  `;
}

async function openAssignDriverModal(saleId) {
  assignDriverSaleId = saleId;
  const order = latestTakeoutOrders.find((o) => o.id === saleId);

  assignDriverSelect.innerHTML = `<option value="">Cargando...</option>`;
  assignDriverFeeInput.value = order && Number(order.delivery_fee) > 0 ? Number(order.delivery_fee).toFixed(2) : '40.00';

  assignDriverModal.classList.add('show');

  try {
    const drivers = await window.driversAPI.getAll();
    if (!drivers || drivers.length === 0) {
      assignDriverSelect.innerHTML = `<option value="">Sin repartidores activos</option>`;
    } else {
      assignDriverSelect.innerHTML = drivers
        .map((d) => `<option value="${d.id}">${escapeHtml(d.name)}</option>`)
        .join('');
    }
  } catch (err) {
    console.error('Error al cargar repartidores:', err);
    assignDriverSelect.innerHTML = `<option value="">No se pudieron cargar</option>`;
  }

  renderAssignDriverBreakdown();
}

function closeAssignDriverModal() {
  assignDriverModal.classList.remove('show');
  assignDriverSaleId = null;
}

assignDriverFeeInput?.addEventListener('input', renderAssignDriverBreakdown);
document.getElementById('btn-cancel-assign-driver')?.addEventListener('click', closeAssignDriverModal);

document.getElementById('btn-confirm-assign-driver')?.addEventListener('click', async () => {
  if (!assignDriverSaleId) return;
  const driverId = assignDriverSelect.value;
  if (!driverId) {
    toast('Selecciona un repartidor.', 'error');
    return;
  }
  const fee = Number(assignDriverFeeInput.value);
  if (!Number.isFinite(fee) || fee < 0) {
    toast('El envío debe ser un número válido.', 'error');
    return;
  }

  const btn = document.getElementById('btn-confirm-assign-driver');
  btn.disabled = true;
  try {
    await window.comandasAPI.assignDriver(assignDriverSaleId, driverId, fee);
    toast('Repartidor asignado, pedido enviado.', 'success');
    closeAssignDriverModal();
    await loadTakeoutOrders();
  } catch (err) {
    console.error('Error al asignar repartidor:', err);
    toast(err && err.message ? err.message : 'No se pudo asignar el repartidor.', 'error');
  } finally {
    btn.disabled = false;
  }
});

async function loadTakeoutOrders() {
  try {
    const orders = await window.comandasAPI.getTakeoutOrders();
    latestTakeoutOrders = orders || [];

    if (!takeoutGrid) return;

    if (!orders || orders.length === 0) {
      takeoutGrid.innerHTML = `
        <div class="empty-takeout">Sin pedidos para llevar en curso.</div>
      `;
      return;
    }

    takeoutGrid.innerHTML = orders
      .map((o) =>
        o.is_delivery
          ? deliveryCardHtml(o)
          : `
          <div class="table-card takeout-card" data-sale-id="${o.id}">
            <h3>🛍️ #${o.id}</h3>
            <span class="status-label">En curso</span>
            <div class="table-total">${fmt(o.total)}</div>
          </div>
        `
      )
      .join('');

    takeoutGrid.querySelectorAll('.btn-delivery-status').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const saleId = Number(btn.dataset.saleId);
        if (btn.dataset.action === 'assign-driver') {
          openAssignDriverModal(saleId);
        } else {
          handleSetDeliveryStatus(saleId, btn.dataset.action);
        }
      });
    });

    takeoutGrid.querySelectorAll('.takeout-card').forEach((card) => {
      card.addEventListener('click', () => {
        openTakeoutScreen(Number(card.dataset.saleId));
      });
    });
  } catch (err) {
    console.error('Error al cargar los pedidos para llevar:', err);
  }
}

// Refresca ambas listas del mapa (mesas + para llevar) a la vez; es lo que
// se usa en todo punto donde antes solo se refrescaban las mesas.
async function refreshTablesScreen() {
  await Promise.all([loadTables(), loadTakeoutOrders()]);
}

document.getElementById('btn-new-takeout').addEventListener('click', async () => {
  try {
    const opened = await window.comandasAPI.openTakeout();
    await openTakeoutScreen(opened.id);
  } catch (err) {
    console.error('Error al abrir el pedido para llevar:', err);

    toast(
      err && err.message
        ? err.message
        : 'No se pudo abrir el pedido para llevar.',
      'error'
    );
  }
});

// ==========================================================================
// ACTUALIZACIÓN AUTOMÁTICA DEL MAPA
// ==========================================================================

function startTablesAutoRefresh() {
  // Evitar intervalos duplicados.
  stopTablesAutoRefresh();

  tablesRefreshInterval = setInterval(async () => {
    // Solo actualizamos si realmente estamos en el mapa de mesas.
    if (
      tablesScreen &&
      orderScreen &&
      tablesScreen.style.display !== 'none' &&
      orderScreen.style.display === 'none'
    ) {
      await refreshTablesScreen();
    }
  }, AUTO_REFRESH_MS);
}

function stopTablesAutoRefresh() {
  if (tablesRefreshInterval) {
    clearInterval(tablesRefreshInterval);
    tablesRefreshInterval = null;
  }
}

// Botón ACTUALIZAR manual
document.getElementById('btn-refresh-tables').addEventListener('click', async () => {
  await refreshTablesScreen();
});

// Regresar al menú principal
document.getElementById('btn-back').addEventListener('click', () => {
  stopTablesAutoRefresh();
  stopOrderAutoRefresh();

  window.api.sendAction('open-menu');
});

// ==========================================================================
// CATÁLOGO
// ==========================================================================
// Se carga una sola vez y se reutiliza en todas las mesas.

async function ensureCatalog() {
  if (catalogLoaded) return;

  const [products, promos, recipesRaw, productModifierGroups, promotionModifierGroups] = await Promise.all([
    window.db.products.getAll(),
    window.db.promotions.getAll(),
    window.db.recipes.getAllWithStock(),
    window.db.productModifierGroups.getAll(),
    window.db.promotionModifierGroups.getAll()
  ]);

  allProducts = products.filter((p) => p.active);
  allPromotions = promos.filter((p) => p.active);
  productAvailability = computeProductAvailability(recipesRaw);

  productModifierGroupsByProduct = new Map();
  (productModifierGroups || []).forEach((row) => {
    if (!productModifierGroupsByProduct.has(row.product_id)) {
      productModifierGroupsByProduct.set(row.product_id, new Map());
    }
    productModifierGroupsByProduct.get(row.product_id).set(row.group_name, Math.max(1, Number(row.qty) || 1));
  });

  promotionModifierGroupsByPromotion = new Map();
  (promotionModifierGroups || []).forEach((row) => {
    if (!promotionModifierGroupsByPromotion.has(row.promotion_id)) {
      promotionModifierGroupsByPromotion.set(row.promotion_id, new Map());
    }
    promotionModifierGroupsByPromotion.get(row.promotion_id).set(row.group_name, Math.max(1, Number(row.qty) || 1));
  });

  catalogLoaded = true;
}

// ==========================================================================
// PROMOCIONES
// ==========================================================================

// Una promo con applicable_category=null aplica a todas las categorías.
// Si tiene una categoría asignada, solo se ofrece cuando esa es la categoría
// que se está explorando (o en las pestañas "Todos"/"Promociones").
function promosForSelectedCategory() {
  if (selectedCategory === 'all' || selectedCategory === 'promo') return allPromotions;
  return allPromotions.filter((p) => !p.applicable_category || p.applicable_category === selectedCategory);
}

function renderPromoStrip() {
  const visiblePromos = promosForSelectedCategory();
  if (visiblePromos.length === 0) {
    promoStrip.classList.remove('has-items');
    promoStrip.innerHTML = '';
    return;
  }

  promoStrip.classList.add('has-items');

  promoStrip.innerHTML = visiblePromos
    .map(
      (promo) => `
        <div class="promo-card" data-id="${promo.id}">
          <span class="promo-badge">PROMO</span>
          <h4>${escapeHtml(promo.name)}</h4>
          <p>${escapeHtml(promo.description || '')}</p>
          <div class="price">${fmt(promo.price)}</div>
        </div>
      `
    )
    .join('');

  promoStrip.querySelectorAll('.promo-card').forEach((card) => {
    card.addEventListener('click', () => {
      const promo = allPromotions.find(
        (p) => p.id === Number(card.dataset.id)
      );

      if (promo) {
        addToOrder({
          id: promo.id,
          name: promo.name,
          itemType: 'promo',
          price: promo.price
        });
      }
    });
  });
}

// ==========================================================================
// PRODUCTOS
// ==========================================================================

function renderProducts() {
  const filterText = searchInput.value.trim().toLowerCase();

  if (selectedCategory === 'promo') {
    productsGrid.innerHTML = `
      <div class="empty-catalog">
        ↑ Selecciona una promoción en la franja de arriba.
      </div>
    `;
    return;
  }

  const filtered = allProducts.filter((product) => {
    const matchesCategory =
      selectedCategory === 'all' ||
      product.category === selectedCategory;

    const matchesSearch =
      product.name.toLowerCase().includes(filterText);

    return matchesCategory && matchesSearch;
  });

  if (filtered.length === 0) {
    productsGrid.innerHTML = `
      <div class="empty-catalog">
        Sin resultados.
      </div>
    `;
    return;
  }

  productsGrid.innerHTML = filtered
    .map((product) => {
      const isTracked = product.stock != null;
      const isOut = isTracked && product.stock <= 0;
      const isLow = isTracked && !isOut && product.stock <= 5;
      const avail = productAvailability[product.id];
      const isNoInsumos = avail && avail.status === 'rojo';

      const badgeClass = isOut || isNoInsumos
        ? 'out'
        : isLow
          ? 'low'
          : '';

      const stockBadge = isNoInsumos
        ? `<div class="stock-badge out">Sin insumos</div>`
        : isTracked
          ? `
          <div class="stock-badge ${badgeClass}">
            ${isOut ? 'Agotado' : `Existencia: ${product.stock}`}
          </div>
        `
          : '';

      const title = isNoInsumos && avail.shortInsumo
        ? ` title="Sin insumos: falta &quot;${escapeHtml(avail.shortInsumo.name)}&quot; (${avail.shortInsumo.stock} ${escapeHtml(avail.shortInsumo.unit || '')} disponibles)"`
        : '';

      return `
        <div
          class="product-card ${isOut || isNoInsumos ? 'is-out-of-stock' : ''}"
          data-id="${product.id}"${title}
        >
          <h3>${escapeHtml(product.name)}</h3>
          <div class="price">${fmt(product.price)}</div>
          ${stockBadge}
        </div>
      `;
    })
    .join('');

  productsGrid.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', (ev) => {
      const product = allProducts.find(
        (p) => p.id === Number(card.dataset.id)
      );

      if (!product) return;

      if (product.stock != null && product.stock <= 0) {
        toast(
          `"${product.name}" no tiene existencia disponible.`,
          'error'
        );
        return;
      }

      const avail = productAvailability[product.id];
      if (avail && avail.status === 'rojo') {
        toast(
          avail.shortInsumo
            ? `Sin insumos para preparar "${product.name}": falta "${avail.shortInsumo.name}" (${avail.shortInsumo.stock} ${avail.shortInsumo.unit || ''} disponibles).`
            : `Sin insumos para preparar "${product.name}".`,
          'error'
        );
        return;
      }

      // Shift+clic: pregunta la cantidad de un jalón (p.ej. 50 alitas sin
      // dar 50 clics). Sin Shift, usa el buffer numérico tecleado antes del
      // clic si hay uno pendiente (ver qtyBufferConsume en common.js).
      let qty = 1;
      if (ev.shiftKey) {
        const answer = window.prompt(`¿Cuántos "${product.name}" quieres agregar?`, '1');
        if (answer === null) return;
        qty = Math.max(1, Math.min(999, parseInt(answer, 10) || 1));
      } else if (window.qtyBufferConsume) {
        const buffered = window.qtyBufferConsume();
        if (buffered) qty = buffered;
      }

      addToOrder({
        id: product.id,
        name: product.name,
        itemType: 'product',
        price: product.price,
        quantity: qty
      });
    });
  });
}

// ==========================================================================
// CATEGORÍAS
// ==========================================================================

document.getElementById('categories-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-btn');

  if (!btn) return;

  document
    .querySelectorAll('.cat-btn')
    .forEach((b) => b.classList.remove('active'));

  btn.classList.add('active');

  selectedCategory = btn.dataset.category;

  renderPromoStrip();
  renderProducts();
});

searchInput.addEventListener('input', () => {
  renderProducts();
});

// ==========================================================================
// COMANDA DE LA MESA
// ==========================================================================
// Persistida en base de datos en tiempo real.

function setOrderScreenLabels(mode, identifier) {
  document.getElementById('order-table-title').textContent =
    mode === 'llevar' ? `🛍️ PARA LLEVAR #${identifier}` : `Mesa ${identifier}`;

  cartHeaderTitle.textContent =
    mode === 'llevar' ? 'Consumo del pedido' : 'Consumo de la mesa';

  btnCancelTable.textContent =
    mode === 'llevar' ? 'Cancelar pedido' : 'Cancelar mesa';
}

async function openTableScreen(tableNumber) {
  currentOrderMode = 'mesa';
  currentTableNumber = tableNumber;

  await ensureCatalog();

  renderPromoStrip();
  renderProducts();

  try {
    const opened = await window.comandasAPI.openTable(tableNumber);

    currentSaleId = opened.id;

    setOrderScreenLabels('mesa', tableNumber);

    tablesScreen.style.display = 'none';
    orderScreen.style.display = 'flex';

    // Detener actualización del mapa mientras estamos dentro
    // de la comanda.
    stopTablesAutoRefresh();

    await refreshOrder();

    // Iniciar actualización automática de la comanda.
    startOrderAutoRefresh();

  } catch (err) {
    console.error('Error al abrir la mesa:', err);

    toast(
      err && err.message
        ? err.message
        : 'No se pudo abrir la mesa.',
      'error'
    );
  }
}

// ==========================================================================
// COMANDA DE UN PEDIDO PARA LLEVAR
// ==========================================================================

async function openTakeoutScreen(saleId) {
  currentOrderMode = 'llevar';
  currentTableNumber = null;
  currentSaleId = saleId;

  await ensureCatalog();

  renderPromoStrip();
  renderProducts();

  setOrderScreenLabels('llevar', saleId);

  tablesScreen.style.display = 'none';
  orderScreen.style.display = 'flex';

  stopTablesAutoRefresh();

  try {
    await refreshOrder();
  } catch (err) {
    console.error('Error al abrir el pedido para llevar:', err);

    toast(
      err && err.message
        ? err.message
        : 'No se pudo abrir el pedido para llevar.',
      'error'
    );
  }

  startOrderAutoRefresh();
}

// ==========================================================================
// REGRESAR AL MAPA DE MESAS
// ==========================================================================

document
  .getElementById('btn-back-to-tables')
  .addEventListener('click', async () => {
    stopOrderAutoRefresh();

    orderScreen.style.display = 'none';
    tablesScreen.style.display = 'flex';

    currentOrderMode = null;
    currentSaleId = null;
    currentTableNumber = null;
    currentItems = [];

    await refreshTablesScreen();

    startTablesAutoRefresh();
  });

// ==========================================================================
// REFRESCAR COMANDA
// ==========================================================================

async function refreshOrder() {
  if (currentOrderMode === 'mesa' && currentTableNumber == null) return;
  if (currentOrderMode === 'llevar' && currentSaleId == null) return;
  if (currentOrderMode == null) return;

  try {
    const sale = currentOrderMode === 'mesa'
      ? await window.comandasAPI.getOpenSale(currentTableNumber)
      : await window.comandasAPI.getOpenSaleById(currentSaleId);

    // La mesa/pedido pudo haber sido cobrado o cancelado desde otra
    // estación.
    if (!sale) {
      currentItems = [];

      if (totalEl) {
        totalEl.textContent = fmt(0);
      }

      // Si seguimos dentro de la comanda pero la venta ya no existe,
      // regresamos automáticamente al mapa.
      if (
        orderScreen &&
        orderScreen.style.display !== 'none'
      ) {
        const wasTakeout = currentOrderMode === 'llevar';

        stopOrderAutoRefresh();

        orderScreen.style.display = 'none';
        tablesScreen.style.display = 'flex';

        currentOrderMode = null;
        currentSaleId = null;
        currentTableNumber = null;
        currentItems = [];

        await refreshTablesScreen();
        startTablesAutoRefresh();

        toast(
          wasTakeout
            ? 'El pedido fue cobrado o cancelado desde otra estación.'
            : 'La mesa fue cerrada o cancelada desde otra estación.',
          'default'
        );
      }

      return;
    }

    // Si la venta cambió, actualizamos el ID.
    currentSaleId = sale.id;

    currentItems = sale.items || [];

    renderCart(sale.total);

  } catch (err) {
    console.error(
      'Error al actualizar automáticamente la comanda:',
      err
    );
  }
}

// ==========================================================================
// ACTUALIZACIÓN AUTOMÁTICA DE LA COMANDA
// ==========================================================================

function startOrderAutoRefresh() {
  stopOrderAutoRefresh();

  orderRefreshInterval = setInterval(async () => {
    if (
      orderScreen &&
      orderScreen.style.display !== 'none' &&
      currentSaleId != null
    ) {
      await refreshOrder();
    }
  }, AUTO_REFRESH_MS);
}

function stopOrderAutoRefresh() {
  if (orderRefreshInterval) {
    clearInterval(orderRefreshInterval);
    orderRefreshInterval = null;
  }
}

// ==========================================================================
// SELECTOR DE SALSA -- modal vanilla, igual patrón que openQtyKeypad en
// common.js (creado una sola vez, reusado, resuelto vía Promise). count
// controla cuántas salsas hay que elegir (1 para un producto normal con
// grupo "Salsas", más para un combo con product_modifier_groups.qty > 1,
// p.ej. PROMO 40 ALITAS pidiendo 2): el botón "Agregar" queda deshabilitado
// hasta elegir exactamente esa cantidad. Devuelve un arreglo de
// modificadores elegidos, o null si se canceló.
// ==========================================================================

async function getSauceModifiers() {
  if (!cachedSauceModifiers) {
    cachedSauceModifiers = await window.db.modifiers.list('Salsas');
  }
  return cachedSauceModifiers;
}

let __sauceSelectorResolve = null;
let __sauceSelectorChoices = [];
let __sauceSelectorCount = 1;

function ensureSauceSelectorModal() {
  let overlay = document.getElementById('sauce-selector-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'sauce-selector-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content sauce-selector-box">
      <h3 id="sauce-selector-title">Elige la salsa</h3>
      <div id="sauce-selector-grid" class="sauce-selector-grid"></div>
      <div class="modal-buttons">
        <button type="button" class="btn-secondary" id="sauce-selector-cancel">Cancelar</button>
        <button type="button" class="btn-primary" id="sauce-selector-confirm" disabled>Agregar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) resolveSauceSelector(null);
  });
  overlay.querySelector('#sauce-selector-cancel').addEventListener('click', () => resolveSauceSelector(null));
  overlay.querySelector('#sauce-selector-confirm').addEventListener('click', () => resolveSauceSelector(__sauceSelectorChoices));

  return overlay;
}

function resolveSauceSelector(value) {
  document.getElementById('sauce-selector-overlay')?.classList.remove('show');
  const resolve = __sauceSelectorResolve;
  __sauceSelectorResolve = null;
  __sauceSelectorChoices = [];
  if (resolve) resolve(value);
}

async function showSauceSelector(count = 1) {
  count = Math.max(1, Number(count) || 1);
  __sauceSelectorCount = count;

  const overlay = ensureSauceSelectorModal();
  const grid = document.getElementById('sauce-selector-grid');
  const confirmBtn = document.getElementById('sauce-selector-confirm');
  const title = document.getElementById('sauce-selector-title');

  __sauceSelectorChoices = [];
  confirmBtn.disabled = true;
  title.textContent = count > 1 ? `Elige ${count} salsas` : 'Elige la salsa';
  grid.innerHTML = `<div class="sauce-selector-loading">Cargando salsas...</div>`;
  overlay.classList.add('show');

  let modifiers = [];
  try {
    modifiers = await getSauceModifiers();
  } catch (err) {
    console.error('No se pudieron cargar las salsas:', err);
    grid.innerHTML = `<div class="sauce-selector-loading">No se pudieron cargar las salsas.</div>`;
    return new Promise((resolve) => { __sauceSelectorResolve = resolve; });
  }

  grid.innerHTML = modifiers
    .map((m) => `
      <button type="button" class="sauce-option" data-id="${m.id}">
        ${escapeHtml(m.name)}
      </button>
    `)
    .join('');

  grid.querySelectorAll('.sauce-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const already = __sauceSelectorChoices.some((c) => c.id === id);
      if (already) {
        __sauceSelectorChoices = __sauceSelectorChoices.filter((c) => c.id !== id);
        btn.classList.remove('selected');
      } else if (__sauceSelectorChoices.length < __sauceSelectorCount) {
        const modifier = modifiers.find((m) => m.id === id);
        if (modifier) {
          __sauceSelectorChoices.push(modifier);
          btn.classList.add('selected');
        }
      }
      confirmBtn.disabled = __sauceSelectorChoices.length !== __sauceSelectorCount;
    });
  });

  return new Promise((resolve) => {
    __sauceSelectorResolve = resolve;
  });
}

// ==========================================================================
// AGREGAR PRODUCTO / PROMOCIÓN
// ==========================================================================

async function addToOrder(item) {
  try {
    // Si el producto pertenece al grupo "Salsas" (ver product_modifier_groups,
    // asignado hoy a ALITAS/BONELESS) se exige elegir salsa(s) antes de
    // agregarlo. Una promoción/paquete puede pedir lo mismo vía su propia
    // tabla (promotion_modifier_groups, ver
    // 20260901000000_promotion_modifier_groups.sql) -- antes solo los
    // productos pasaban por este chequeo. Si el usuario cancela el
    // selector, se aborta sin llamar a addItem.
    const groups = item.itemType === 'product'
      ? productModifierGroupsByProduct.get(item.id)
      : item.itemType === 'promo'
        ? promotionModifierGroupsByPromotion.get(item.id)
        : null;
    const saucesQty = groups && groups.get('Salsas');
    if (saucesQty) {
      const chosen = await showSauceSelector(saucesQty);
      if (!chosen) return;
      item = { ...item, modifierIds: chosen.map((c) => c.id), modifierNames: chosen.map((c) => c.name) };
    }

    await window.comandasAPI.addItem(
      currentSaleId,
      item
    );

    await refreshOrder();
    refreshAvailability();

  } catch (err) {
    console.error(err);

    toast(
      err && err.message
        ? err.message
        : 'No se pudo agregar el producto.',
      'error'
    );

    // Fuerza a releer existencia actualizada del catálogo.
    catalogLoaded = false;

    await ensureCatalog();

    renderProducts();
  }
}

// ==========================================================================
// RENDERIZAR CARRITO
// ==========================================================================

let lastFocusedQtyIndex = null; // índice en currentItems[] del último input de cantidad enfocado -- ver window.__whQtyHooks

function renderCart(total) {
  // La comanda se refresca sola cada AUTO_REFRESH_MS: si se reconstruye el
  // DOM mientras el cajero está a mitad de teclear una cantidad a mano, le
  // borra lo que llevaba escrito. Mientras el input de cantidad tenga foco,
  // solo se actualiza el total y se deja el resto de la comanda como está;
  // en cuanto se suelta el foco (blur/Enter ya manda el valor), el próximo
  // refresh vuelve a pintar todo con normalidad.
  const activeQtyInput = document.activeElement;
  if (
    activeQtyInput &&
    activeQtyInput.classList &&
    activeQtyInput.classList.contains('qty-input') &&
    cartItemsContainer.contains(activeQtyInput)
  ) {
    totalEl.textContent = fmt(total);
    return;
  }

  if (currentItems.length === 0) {
    cartItemsContainer.innerHTML = `
      <div class="cart-empty-state">
        <p>Aún no hay consumo</p>
        <span>Agrega productos del catálogo</span>
      </div>
    `;
  } else {
    cartItemsContainer.innerHTML = currentItems
      .map((item, index) => {
        const product =
          item.item_type === 'product'
            ? allProducts.find(
                (p) => p.id === item.ref_id
              )
            : null;

        const stock = product
          ? product.stock
          : null;

        const modifiersLine = (item.sale_item_modifiers && item.sale_item_modifiers.length > 0)
          ? `
            <div class="cart-item-modifiers">
              ${item.sale_item_modifiers
                .map((sim) => `• ${escapeHtml(sim.modifiers ? sim.modifiers.name : '')}`)
                .join('<br>')}
            </div>
          `
          : '';

        let stockLine = '';

        if (stock != null) {
          const remaining =
            stock - item.quantity;

          const cls =
            remaining <= 0
              ? 'out'
              : remaining <= 5
                ? 'low'
                : '';

          stockLine = `
            <div class="cart-item-stock ${cls}">
              Disponibles después de cobrar:
              ${Math.max(0, remaining)}
            </div>
          `;
        }

        return `
          <div
            class="cart-item ${
              item.item_type === 'promo'
                ? 'is-promo'
                : ''
            }"
          >
            <div class="cart-item-info">

              <h4>
                ${escapeHtml(item.name)}
              </h4>

              ${
                item.item_type === 'promo'
                  ? '<span class="promo-flag">PROMOCIÓN</span>'
                  : ''
              }

              <span class="line-price">
                ${fmt(item.subtotal)}
              </span>

              ${modifiersLine}

              ${stockLine}

            </div>

            <div class="cart-item-controls">

              <button
                class="btn-qty btn-minus"
                data-index="${index}"
              >
                −
              </button>

              <input
                type="number"
                class="qty-input"
                min="1"
                max="999"
                value="${item.quantity}"
                data-index="${index}"
              >

              <button
                class="btn-qty btn-plus"
                data-index="${index}"
              >
                +
              </button>

              <button
                class="qty-fast-btn"
                data-index="${index}"
                data-delta="5"
                title="Agregar 5 (Ctrl++)"
              >
                +5
              </button>

              <button
                class="qty-fast-btn"
                data-index="${index}"
                data-delta="10"
                title="Agregar 10 de un jalón"
              >
                +10
              </button>

              <button
                class="btn-remove"
                data-index="${index}"
                title="Quitar"
              >
                ✕
              </button>

            </div>
          </div>
        `;
      })
      .join('');

    // --------------------------------------------------------------
    // BOTÓN MENOS / MÁS / +5 / +10
    // --------------------------------------------------------------
    cartItemsContainer
      .querySelectorAll('.btn-minus')
      .forEach((b) => {
        b.addEventListener('click', () => addQuantity(Number(b.dataset.index), -1));
      });

    cartItemsContainer
      .querySelectorAll('.btn-plus')
      .forEach((b) => {
        b.addEventListener('click', () => addQuantity(Number(b.dataset.index), 1));
      });

    cartItemsContainer
      .querySelectorAll('.qty-fast-btn')
      .forEach((b) => {
        b.addEventListener('click', () => addQuantity(Number(b.dataset.index), Number(b.dataset.delta)));
      });

    // --------------------------------------------------------------
    // INPUT DE CANTIDAD EDITABLE
    // --------------------------------------------------------------
    cartItemsContainer
      .querySelectorAll('.qty-input')
      .forEach((input) => {
        const idx = Number(input.dataset.index);
        input.addEventListener('click', () => input.select());
        input.addEventListener('focus', () => {
          lastFocusedQtyIndex = idx;
          input.select();
        });
        input.addEventListener('change', () => updateQtyDirect(idx, input.value));
        input.addEventListener('blur', () => updateQtyDirect(idx, input.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            updateQtyDirect(idx, input.value);
            input.blur();
          }
        });
        input.addEventListener('dblclick', () => {
          // Sin este blur, el input sigue "enfocado" mientras el teclado
          // numérico está abierto -- el guard de renderCart (arriba) se
          // saltaría el repintado tras confirmar y dejaría la cantidad vieja
          // en pantalla hasta el siguiente refresh automático.
          input.blur();
          // Recaptura el id real del artículo: la comanda se refresca sola
          // cada pocos segundos (otra estación puede tocarla mientras el
          // teclado numérico está abierto), así que al confirmar se vuelve a
          // buscar por id en vez de confiar ciegamente en que el índice
          // capturado al abrir el modal siga apuntando al mismo renglón.
          const itemId = currentItems[idx] ? currentItems[idx].id : null;
          if (itemId == null) return;
          openQtyKeypad(currentItems[idx].quantity, (val) => {
            const freshIndex = currentItems.findIndex((i) => i.id === itemId);
            if (freshIndex === -1) {
              toast('Ese producto ya no está en la comanda.', 'error');
              return;
            }
            updateQtyDirect(freshIndex, val);
          });
        });
      });

    // --------------------------------------------------------------
    // BOTÓN ELIMINAR
    // --------------------------------------------------------------
    cartItemsContainer
      .querySelectorAll('.btn-remove')
      .forEach((b) => {
        b.addEventListener('click', () => removeAtIndex(Number(b.dataset.index)));
      });
  }

  totalEl.textContent = fmt(total);
}

// ==========================================================================
// CAMBIAR CANTIDAD -- por índice en currentItems[] (estable entre el clic y
// el siguiente render, igual que en sales-renderer.js). comandaUpdateItemQty
// recibe la cantidad ABSOLUTA, así que setQuantity manda item.id + qty tal
// cual; addQuantity solo calcula el delta antes de llamarla.
// ==========================================================================

async function setQuantity(index, qty) {
  const item = currentItems[index];
  if (!item) return;

  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (qty > 999) qty = 999;

  try {
    await window.comandasAPI.updateItemQty(item.id, qty);
    await refreshOrder();
    refreshAvailability();
  } catch (err) {
    console.error(err);

    toast(
      err && err.message
        ? err.message
        : 'No se pudo actualizar la cantidad.',
      'error'
    );

    catalogLoaded = false;
    await ensureCatalog();
    renderProducts();
  }
}

async function removeAtIndex(index) {
  const item = currentItems[index];
  if (!item) return;

  try {
    await window.comandasAPI.removeItem(item.id);
    await refreshOrder();
    refreshAvailability();
  } catch (err) {
    console.error(err);

    toast(
      err && err.message
        ? err.message
        : 'No se pudo eliminar el producto.',
      'error'
    );
  }
}

// A diferencia de setQuantity, un delta negativo que llega a 0 quita el item
// (mismo comportamiento que tenía el botón "-" antes de este cambio).
async function addQuantity(index, delta) {
  const item = currentItems[index];
  if (!item) return;

  const newQty = item.quantity + delta;
  if (newQty <= 0) {
    await removeAtIndex(index);
    return;
  }
  await setQuantity(index, newQty);
}

function updateQtyDirect(index, newVal) {
  setQuantity(index, newVal);
}

// Atajos de teclado +/- sobre "el item seleccionado" (ver common.js): el
// input de cantidad con foco cuenta como seleccionado; si ninguno tiene
// foco, se usa el último item agregado. Enter con buffer numérico pendiente
// aplica esa cantidad al último item agregado.
window.__whQtyHooks = {
  adjustSelected(delta) {
    const idx = lastFocusedQtyIndex != null && currentItems[lastFocusedQtyIndex] ? lastFocusedQtyIndex : currentItems.length - 1;
    if (idx < 0 || !currentItems[idx]) return;
    addQuantity(idx, delta);
  },
  applyToLast(qty) {
    const idx = currentItems.length - 1;
    if (idx < 0) return;
    setQuantity(idx, qty);
  }
};

// ==========================================================================
// CANCELAR MESA
// ==========================================================================

document
// Ticket de cocina de respaldo (independiente del KDS): reimprime en
// cualquier momento el consumo ACTUAL de esta mesa/pedido, vuelto a pedir a
// la BD (kitchen:printTicket -> db.getSaleById), nunca desde currentItems en
// memoria -- así, si se agregaron más productos después del último envío,
// el ticket sale completo y ligado al mismo currentSaleId, sin duplicar ni
// desfasarse.
btnPrintKitchen?.addEventListener('click', async () => {
  if (currentSaleId == null) {
    toast('Todavía no hay una comanda abierta para imprimir.', 'error');
    return;
  }
  btnPrintKitchen.disabled = true;
  try {
    const result = await window.kitchenTicketAPI.print(currentSaleId);
    if (result && result.success) {
      toast('Ticket de cocina enviado a imprimir.', 'success');
    } else if (result && result.reason === 'disabled') {
      toast('La impresión está deshabilitada en Ajustes -> Impresión.', 'error');
    } else {
      toast('No se pudo imprimir el ticket de cocina.', 'error');
    }
  } catch (err) {
    toast('No se pudo imprimir el ticket de cocina.', 'error');
  } finally {
    btnPrintKitchen.disabled = false;
  }
});

document
  .getElementById('btn-cancel-table')
  .addEventListener('click', async () => {
    const isTakeout = currentOrderMode === 'llevar';

    if (
      !confirm(
        isTakeout
          ? '¿Cancelar este pedido? Se perderá todo el consumo registrado.'
          : '¿Cancelar esta mesa? Se perderá todo el consumo registrado.'
      )
    ) {
      return;
    }

    try {
      await window.comandasAPI.cancelTable(
        currentSaleId
      );

      stopOrderAutoRefresh();

      orderScreen.style.display = 'none';
      tablesScreen.style.display = 'flex';

      currentOrderMode = null;
      currentSaleId = null;
      currentTableNumber = null;
      currentItems = [];

      await refreshTablesScreen();

      startTablesAutoRefresh();

    } catch (err) {
      console.error(err);

      toast(
        err && err.message
          ? err.message
          : isTakeout
            ? 'No se pudo cancelar el pedido.'
            : 'No se pudo cancelar la mesa.',
        'error'
      );
    }
  });

// ==========================================================================
// PEDIR LA CUENTA / COBRAR
// ==========================================================================

document
  .getElementById('btn-request-bill')
  .addEventListener('click', () => {

    const isTakeout = currentOrderMode === 'llevar';

    if (currentItems.length === 0) {
      toast(
        isTakeout
          ? 'El pedido no tiene consumo registrado.'
          : 'La mesa no tiene consumo registrado.',
        'error'
      );
      return;
    }

    const total =
      currentItems.reduce(
        (s, i) =>
          s + Number(i.subtotal || 0),
        0
      );

    document.getElementById(
      'checkout-title'
    ).textContent = isTakeout
      ? `Cobrar Pedido #${currentSaleId}`
      : `Cobrar Mesa ${currentTableNumber}`;

    checkoutTotalAmount.textContent =
      fmt(total);

    amountReceivedInput.value = '';

    changeAmountEl.textContent =
      fmt(0);

    selectedPayMethod =
      'efectivo';

    document
      .querySelectorAll('.pay-method-btn')
      .forEach((b) =>
        b.classList.toggle(
          'active',
          b.dataset.method === 'efectivo'
        )
      );

    cashFields.style.display =
      'block';

    checkoutModal.classList.add(
      'show'
    );

    amountReceivedInput.focus();
  });

// ==========================================================================
// CANCELAR COBRO
// ==========================================================================

document
  .getElementById('btn-cancel-checkout')
  .addEventListener('click', () => {
    checkoutModal.classList.remove(
      'show'
    );
  });

// ==========================================================================
// MÉTODOS DE PAGO
// ==========================================================================

document
  .querySelectorAll('.pay-method-btn')
  .forEach((btn) => {

    btn.addEventListener(
      'click',
      () => {

        document
          .querySelectorAll(
            '.pay-method-btn'
          )
          .forEach((b) =>
            b.classList.remove(
              'active'
            )
          );

        btn.classList.add(
          'active'
        );

        selectedPayMethod =
          btn.dataset.method;

        cashFields.style.display =
          selectedPayMethod ===
          'efectivo'
            ? 'block'
            : 'none';
      }
    );

  });

// ==========================================================================
// CALCULAR CAMBIO
// ==========================================================================

amountReceivedInput.addEventListener(
  'input',
  () => {

    const total =
      currentItems.reduce(
        (s, i) =>
          s + Number(i.subtotal || 0),
        0
      );

    const received =
      Number(
        amountReceivedInput.value
      ) || 0;

    const change =
      received - total;

    changeAmountEl.textContent =
      fmt(
        change > 0
          ? change
          : 0
      );
  }
);

// ==========================================================================
// CONFIRMAR COBRO
// ==========================================================================

document
  .getElementById('btn-confirm-checkout')
  .addEventListener(
    'click',
    async () => {

      const total =
        currentItems.reduce(
          (s, i) =>
            s + Number(i.subtotal || 0),
          0
        );

      let amountReceived = null;
      let changeGiven = null;

      if (
        selectedPayMethod ===
        'efectivo'
      ) {

        amountReceived =
          Number(
            amountReceivedInput.value
          ) || 0;

        if (
          amountReceived <
          total
        ) {

          toast(
            'El monto recibido es menor al total.',
            'error'
          );

          return;
        }

        changeGiven =
          amountReceived -
          total;
      }

      try {

        const result =
          await window.comandasAPI.closeTable(
            currentSaleId,
            {
              discount: 0,
              paymentMethod:
                selectedPayMethod,
              amountReceived,
              changeGiven
            }
          );

        toast(
          currentOrderMode === 'llevar'
            ? `Pedido para llevar cobrado: ${result.folio}`
            : `Mesa ${currentTableNumber} cobrada: ${result.folio}`,
          'success'
        );

        // Para Ctrl+P (reimprimir el último ticket) -- ver common.js.
        window.__lastSaleId = result.id;

        alertLowStockInsumos();
        catalogLoaded = false; // fuerza a releer stock/receta en la próxima mesa

        // ------------------------------------------------------------
        // IMPRESIÓN
        // ------------------------------------------------------------

        if (chkPrint.checked) {

          try {

            const printResult =
              await window.printerAPI.printTicket(
                result.id
              );

            if (printResult.reason !== 'disabled') {
              toast(
                printResult.success
                  ? 'Ticket de la mesa enviado a imprimir.'
                  : 'No se pudo imprimir el ticket.',
                printResult.success
                  ? 'success'
                  : 'error'
              );
            }

          } catch (err) {

            console.error(
              'Error al imprimir ticket:',
              err
            );

            toast(
              'No se pudo imprimir el ticket.',
              'error'
            );
          }
        }

        // ------------------------------------------------------------
        // REGRESAR AL MAPA
        // ------------------------------------------------------------

        checkoutModal.classList.remove(
          'show'
        );

        stopOrderAutoRefresh();

        orderScreen.style.display =
          'none';

        tablesScreen.style.display =
          'flex';

        currentOrderMode = null;
        currentSaleId = null;
        currentTableNumber = null;
        currentItems = [];

        await refreshTablesScreen();

        startTablesAutoRefresh();

      } catch (err) {

        console.error(err);

        // Muestra el motivo real.
        toast(
          err && err.message
            ? err.message
            : 'No se pudo cerrar la cuenta de la mesa.',
          'error'
        );

        // Fuerza actualización de existencia.
        catalogLoaded = false;

        await ensureCatalog();

        renderProducts();
      }

    }
  );

// ==========================================================================
// VISIBILIDAD / CAMBIO DE PANTALLA
// ==========================================================================
//
// Si Electron vuelve a mostrar esta página después de estar en segundo
// plano, hacemos una actualización inmediata.

document.addEventListener(
  'visibilitychange',
  async () => {

    if (
      document.visibilityState !==
      'visible'
    ) {
      return;
    }

    if (
      tablesScreen &&
      orderScreen &&
      tablesScreen.style.display !==
        'none' &&
      orderScreen.style.display ===
        'none'
    ) {

      await refreshTablesScreen();

    } else if (
      orderScreen &&
      orderScreen.style.display !==
        'none' &&
      currentSaleId != null
    ) {

      await refreshOrder();

    }
  }
);

// ==========================================================================
// INICIALIZACIÓN
// ==========================================================================

document.addEventListener(
  'DOMContentLoaded',
  async () => {

    try {

      session =
        await guardPermission('comandas', 'can_view');

      if (!session) {
        return;
      }

      document.getElementById(
        'badge-user'
      ).textContent =
        `${session.displayName} · Mapa de comandas`;

      await refreshTablesScreen();

      // Iniciar actualización automática
      // del mapa de mesas.
      startTablesAutoRefresh();

      // Estado inicial de Realtime: al recargar esta pantalla (main.js hace
      // loadFile en cada navegación) se pierde cualquier listener previo, así
      // que se pregunta el estado actual en vez de esperar el próximo cambio.
      if (window.orderAlertAPI) {
        try {
          const connected = await window.orderAlertAPI.getStatus();
          applyRealtimeStatus(connected);
        } catch (err) {
          console.error('Error al consultar el estado de Realtime:', err);
          applyRealtimeStatus(false);
        }
      }

      // Si venimos de "Ver pedido" en la alerta de cocina, abrimos esa
      // mesa (o ese pedido para llevar) directamente en vez de dejar al
      // usuario en el mapa.
      const pendingTable = localStorage.getItem('wh_open_table_on_load');
      const pendingTakeoutId = localStorage.getItem('wh_open_takeout_on_load');

      if (pendingTable) {
        localStorage.removeItem('wh_open_table_on_load');
        const n = Number(pendingTable);
        if (n > 0) await openTableScreen(n);
      } else if (pendingTakeoutId) {
        localStorage.removeItem('wh_open_takeout_on_load');
        const id = Number(pendingTakeoutId);
        if (id > 0) await openTakeoutScreen(id);
      }

    } catch (err) {

      console.error(
        'Error durante la inicialización de Comandas:',
        err
      );

      toast(
        err && err.message
          ? err.message
          : 'No se pudo inicializar el módulo de Comandas.',
        'error'
      );

    }

  }
);
// ==========================================================================
// ATAJOS DE TECLADO ESPECÍFICOS DE COMANDAS (Ctrl+K/Ctrl+N/Alt+C) -- el
// resto (F1-F9, Ctrl+S, Esc) los maneja common.js de forma genérica; estos
// tres necesitan saber en qué pantalla/estado está la comanda, que solo
// vive aquí.
window.addEventListener('app-shortcut', (e) => {
  const insideOrder = orderScreen && orderScreen.style.display !== 'none';

  if (e.detail === 'Ctrl+K') {
    if (insideOrder) searchInput.focus();
    return;
  }

  if (e.detail === 'Ctrl+N') {
    // Solo tiene sentido "nuevo pedido" parado en el mapa de mesas; dentro
    // de una comanda ya en curso, Ctrl+N no tiene una acción clara.
    if (!insideOrder) document.getElementById('btn-new-takeout').click();
    return;
  }

  if (e.detail === 'Alt+C') {
    // Reusa el botón real (misma validación de "sin consumo registrado"
    // que ya tiene su click handler) en vez de duplicar la lógica de cobro
    // aquí -- Alt+C solo ABRE el modal de cobro, nunca confirma el pago
    // por sí solo (eso lo sigue haciendo el cajero a mano, con el monto).
    if (insideOrder) document.getElementById('btn-request-bill').click();
  }
});
