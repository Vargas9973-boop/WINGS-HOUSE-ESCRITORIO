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

// Semáforo de disponibilidad por producto a partir de recipes+inventory
// (window.db.recipes.getAllWithStock). Copia de common.js: comandas.html no
// incluye common.js.
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

// Solo avanza el estado (pendiente -> en_camino -> entregado); el resto de
// los datos de domicilio (cliente, dirección, repartidor) se capturan una
// sola vez desde la web al crear el pedido y aquí solo se muestran.
function deliveryCardHtml(o) {
  const status = o.delivery_status || 'pendiente';

  return `
    <div class="table-card takeout-card delivery-card" data-sale-id="${o.id}">
      <h3>🛵 #${o.id}</h3>
      <span class="status-label">${deliveryStatusLabel(status)}</span>
      <div class="delivery-info">
        <div class="delivery-address">${escapeHtml(o.delivery_address || 'Sin dirección')}</div>
        ${o.customer_name ? `<div class="delivery-customer">${escapeHtml(o.customer_name)}</div>` : ''}
        <div class="delivery-driver">
          ${o.driver_name ? `Repartidor: ${escapeHtml(o.driver_name)}` : 'Sin repartidor asignado'}
        </div>
      </div>
      <div class="table-total">${fmt(o.total)}</div>
      <div class="delivery-actions">
        ${status !== 'en_camino' && status !== 'entregado'
          ? `<button type="button" class="btn-delivery-status" data-action="en_camino" data-sale-id="${o.id}">🛵 En camino</button>`
          : ''}
        ${status !== 'entregado'
          ? `<button type="button" class="btn-delivery-status" data-action="entregado" data-sale-id="${o.id}">✅ Entregado</button>`
          : ''}
      </div>
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

async function loadTakeoutOrders() {
  try {
    const orders = await window.comandasAPI.getTakeoutOrders();

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
        handleSetDeliveryStatus(Number(btn.dataset.saleId), btn.dataset.action);
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

  const [products, promos, recipesRaw] = await Promise.all([
    window.db.products.getAll(),
    window.db.promotions.getAll(),
    window.db.recipes.getAllWithStock()
  ]);

  allProducts = products.filter((p) => p.active);
  allPromotions = promos.filter((p) => p.active);
  productAvailability = computeProductAvailability(recipesRaw);

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
    card.addEventListener('click', () => {
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

      addToOrder({
        id: product.id,
        name: product.name,
        itemType: 'product',
        price: product.price
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
// AGREGAR PRODUCTO / PROMOCIÓN
// ==========================================================================

async function addToOrder(item) {
  try {
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

function renderCart(total) {
  if (currentItems.length === 0) {
    cartItemsContainer.innerHTML = `
      <div class="cart-empty-state">
        <p>Aún no hay consumo</p>
        <span>Agrega productos del catálogo</span>
      </div>
    `;
  } else {
    cartItemsContainer.innerHTML = currentItems
      .map((item) => {
        const product =
          item.item_type === 'product'
            ? allProducts.find(
                (p) => p.id === item.ref_id
              )
            : null;

        const stock = product
          ? product.stock
          : null;

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

              ${stockLine}

            </div>

            <div class="cart-item-controls">

              <button
                class="btn-qty btn-minus"
                data-id="${item.id}"
              >
                −
              </button>

              <span>
                ${item.quantity}
              </span>

              <button
                class="btn-qty btn-plus"
                data-id="${item.id}"
              >
                +
              </button>

              <button
                class="btn-remove"
                data-id="${item.id}"
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
    // BOTÓN MENOS
    // --------------------------------------------------------------
    cartItemsContainer
      .querySelectorAll('.btn-minus')
      .forEach((b) => {
        b.addEventListener('click', () => {
          changeQty(
            Number(b.dataset.id),
            -1
          );
        });
      });

    // --------------------------------------------------------------
    // BOTÓN MÁS
    // --------------------------------------------------------------
    cartItemsContainer
      .querySelectorAll('.btn-plus')
      .forEach((b) => {
        b.addEventListener('click', () => {
          changeQty(
            Number(b.dataset.id),
            1
          );
        });
      });

    // --------------------------------------------------------------
    // BOTÓN ELIMINAR
    // --------------------------------------------------------------
    cartItemsContainer
      .querySelectorAll('.btn-remove')
      .forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            await window.comandasAPI.removeItem(
              Number(b.dataset.id)
            );

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
        });
      });
  }

  totalEl.textContent = fmt(total);
}

// ==========================================================================
// CAMBIAR CANTIDAD
// ==========================================================================

async function changeQty(itemId, delta) {
  const item = currentItems.find(
    (i) => i.id === itemId
  );

  if (!item) return;

  const newQty =
    item.quantity + delta;

  try {
    await window.comandasAPI.updateItemQty(
      itemId,
      newQty
    );

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

// ==========================================================================
// CANCELAR MESA
// ==========================================================================

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
        await window.auth.getSession();

      if (!session) {

        window.api.sendAction(
          'open-login'
        );

        return;
      }

      if (
        !['admin', 'cajero'].includes(
          session.role
        )
      ) {

        alert(
          'No tienes permiso para acceder a Comandas.'
        );

        window.api.sendAction(
          'open-menu'
        );

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