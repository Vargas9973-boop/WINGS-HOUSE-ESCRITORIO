// ==========================================================================
// ESTADO GENERAL
// ==========================================================================
let allProducts = [];
let allPromotions = [];
let currentClientType = 'public'; // 'public' | 'employee'
let employeeDiscountPct = 20;
let employees = [];
let selectedEmployeeId = null;
let selectedEmployeeSaleType = null;
let selectedEmployeeExtraPayment = null;
let employeeConsumptionRefreshTimer = null;
const EMPLOYEE_CONSUMPTION_REFRESH_MS = 5000;
let employeeAvailableCache = 100; // último "disponible" consultado, para calcular a cobrar sin esperar al RPC en cada tecleo
let cart = [];
let selectedCategory = 'all';
let selectedPayMethod = 'efectivo';
let productAvailability = {}; // productId -> { status: 'rojo'|'amarillo'|'verde', shortInsumo, maxSellable } -- ver computeProductAvailability()
let lastFocusedQtyIndex = null; // índice en cart[] del último input de cantidad enfocado -- ver window.__whQtyHooks más abajo
let productModifierGroupsByProduct = new Map(); // productId -> Map(group_name -> qty), p.ej. 4 -> Map([['Salsas', 1]]) -- ver showSauceSelector()
let promotionModifierGroupsByPromotion = new Map(); // mismo shape que arriba, pero por promotion_id (tabla propia, ver 20260901000000_promotion_modifier_groups.sql)
let cachedSauceModifiers = null; // caché de window.db.modifiers.list('Salsas')

// Semáforo de disponibilidad por producto a partir de recipes+inventory
// (window.db.recipes.getAllWithStock). Copia de common.js: sales.html no
// incluye common.js (arranca sin guardSession para no bloquear el cobro).
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

const CATEGORY_LABELS = {
  Alitas: 'Alitas',
  Boneless: 'Boneless',
  hotdogs: 'Hot-Dogs',
  hamburguesas: 'Hamburguesas',
  papas: 'Papas',
  acompanantes: 'Acompañantes',
  bebidas: 'Bebidas',
  extras: 'Extras'
};

// ==========================================================================
// ELEMENTOS DOM
// ==========================================================================
const modal = document.getElementById('client-type-modal');
const btnPublic = document.getElementById('btn-public');
const btnEmployee = document.getElementById('btn-employee');
const btnChangeClient = document.getElementById('btn-change-client');
const badgeClientType = document.getElementById('badge-client-type');
const productsGrid = document.getElementById('products-grid');
const promoStrip = document.getElementById('promo-strip');
const cartItemsContainer = document.getElementById('cart-items');
const subtotalEl = document.getElementById('subtotal-amount');
const discountEl = document.getElementById('discount-amount');
const totalEl = document.getElementById('total-amount');
const rowDiscount = document.getElementById('row-discount');
const btnCheckout = document.getElementById('btn-checkout');
const btnClearCart = document.getElementById('btn-clear-cart');
const searchInput = document.getElementById('search-input');
const btnBack = document.getElementById('btn-back');
const folioPreview = document.getElementById('folio-preview');

const checkoutModal = document.getElementById('checkout-modal');
const checkoutTotalAmount = document.getElementById('checkout-total-amount');
const cashFields = document.getElementById('cash-fields');
const amountReceivedInput = document.getElementById('amount-received');
const changeAmountEl = document.getElementById('change-amount');
const chkPrint = document.getElementById('chk-print');
const btnConfirmCheckout = document.getElementById('btn-confirm-checkout');
const btnCancelCheckout = document.getElementById('btn-cancel-checkout');

// Pago combinado (Combinar métodos de pago): un solo checkbox que sustituye
// el selector Efectivo/Tarjeta/Transferencia por 3 campos de monto -- solo
// disponible para público general (ver checkout-pay-methods-wrap, que
// updateCheckoutModalForEmployee ya oculta por completo en ventas de
// empleado, así que este bloque nunca queda visible ahí).
const payMethodsButtonsEl = document.querySelector('#checkout-pay-methods-wrap .pay-methods');
const chkSplitPayment = document.getElementById('chk-split-payment');
const splitPaymentFields = document.getElementById('split-payment-fields');
const splitEfectivoInput = document.getElementById('split-efectivo');
const splitTarjetaInput = document.getElementById('split-tarjeta');
const splitTransferenciaInput = document.getElementById('split-transferencia');
const splitRemainingAmount = document.getElementById('split-remaining-amount');
let splitPaymentActive = false;

function updateSplitRemaining() {
  const { total } = cartTotals();
  const sum =
    (Number(splitEfectivoInput.value) || 0) +
    (Number(splitTarjetaInput.value) || 0) +
    (Number(splitTransferenciaInput.value) || 0);
  const remaining = Math.round((total - sum) * 100) / 100;

  splitRemainingAmount.textContent = fmt(remaining);
  splitRemainingAmount.classList.toggle('is-balanced', Math.abs(remaining) < 0.005);
  splitRemainingAmount.classList.toggle('is-over', remaining < -0.004);
}

[splitEfectivoInput, splitTarjetaInput, splitTransferenciaInput].forEach((input) => {
  input.addEventListener('input', updateSplitRemaining);
});

chkSplitPayment.addEventListener('change', () => {
  splitPaymentActive = chkSplitPayment.checked;
  payMethodsButtonsEl.style.display = splitPaymentActive ? 'none' : 'grid';
  splitPaymentFields.style.display = splitPaymentActive ? 'block' : 'none';
  cashFields.style.display = splitPaymentActive
    ? 'none'
    : (selectedPayMethod === 'efectivo' ? 'block' : 'none');

  if (splitPaymentActive) {
    splitEfectivoInput.value = '';
    splitTarjetaInput.value = '';
    splitTransferenciaInput.value = '';
    updateSplitRemaining();
    splitEfectivoInput.focus();
  }
});

function ensureEmployeeSelector() {
  let panel = document.getElementById('employee-selector-panel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'employee-selector-panel';
  panel.style.cssText = 'display:none; margin:12px 0; padding:12px 14px; border:1px solid var(--border-color); border-radius:10px; background:var(--bg-card); color:var(--text-primary);';
  panel.innerHTML = `
    <label for="sale-employee-select">Empleado que realiza la compra</label>

    <select id="sale-employee-select" class="employee-select">
      <option value="">Selecciona un empleado...</option>
    </select>

    <div id="sale-employee-info" class="employee-info"></div>

    <label for="employee-sale-type">Tipo de consumo</label>

    <select id="employee-sale-type" class="employee-select">
      <option value="">Selecciona el tipo de consumo...</option>
      <option value="daily_100">Consumo diario — $100</option>
      <option value="takeaway_credit">Para llevar — Crédito</option>
    </select>
    <div id="employee-extra-payment-container" style="display:none; margin-top:10px;">
      <label for="employee-extra-payment">Pago del excedente</label>

      <select id="employee-extra-payment" class="employee-select">
        <option value="">Selecciona cómo pagar el excedente...</option>
        <option value="cash">Efectivo</option>
        <option value="credit">Crédito semanal</option>
      </select>

      <div id="employee-extra-payment-info" class="employee-info"></div>
    </div>
    <div id="employee-amount-due-info" class="employee-info" style="font-weight:700; margin-top:8px;"></div>
`;
  const anchor = productsGrid?.parentElement || document.body;
  anchor.insertBefore(panel, productsGrid || null);
  panel.querySelector('#sale-employee-select').addEventListener('change', async (e) => {

  selectedEmployeeId = e.target.value ? Number(e.target.value) : null;

  const emp = employees.find(x => x.id === selectedEmployeeId);

  const info = panel.querySelector('#sale-employee-info');

  if (!emp) {
    info.textContent = '';
    stopEmployeeConsumptionAutoRefresh();
    return;
}

try {
    const consumed =
        await window.db.employee.getDailyConsumption(selectedEmployeeId);

    console.log(
        'RESULTADO getDailyConsumption:',
        consumed
    );

    const consumption = Math.min(
        Math.max(Number(consumed || 0), 0),
        100
    );

    const available = Math.max(
        100 - consumption,
        0
    );

    info.textContent =
        'ID: ' + emp.id +
        ' · ' + (emp.role || 'Personal') +
        ' · CONSUMO REAL: $' + consumption.toFixed(2) +
        ' · DISPONIBLE: $' + available.toFixed(2) +
        ' de $100.00';

    console.log(
        'SELECTOR EMPLEADO:',
        {
            employeeId: selectedEmployeeId,
            consumed: consumption,
            available: available
        }
    );

    startEmployeeConsumptionAutoRefresh();

} catch (error) {

    console.error(
        'Error al consultar consumo diario:',
        error
    );

    info.textContent =
        'ID: ' + emp.id +
        ' · ' + (emp.role || 'Personal') +
        ' · No se pudo consultar el consumo de hoy.';
}

});

panel.querySelector('#employee-sale-type').addEventListener('change', (e) => {

    selectedEmployeeSaleType = e.target.value || null;

    const extraContainer = panel.querySelector(
        '#employee-extra-payment-container'
    );

    const extraSelect = panel.querySelector(
        '#employee-extra-payment'
    );

    const extraInfo = panel.querySelector(
        '#employee-extra-payment-info'
    );

    selectedEmployeeExtraPayment = null;

    if (extraSelect) {
        extraSelect.value = '';
    }

    if (extraInfo) {
        extraInfo.textContent = '';
    }

    if (extraContainer) {
        extraContainer.style.display =
            selectedEmployeeSaleType === 'daily_100'
                ? 'block'
                : 'none';
    }

    updateEmployeeAmountDue();

});

panel.querySelector('#employee-extra-payment').addEventListener('change', (e) => {

    selectedEmployeeExtraPayment = e.target.value || null;
    updateEmployeeAmountDue();

});

return panel;
}
async function refreshEmployeeConsumptionDisplay() {
  const panel = document.getElementById('employee-selector-panel');

  if (!panel || !selectedEmployeeId) {
    return;
  }

  const emp = employees.find(
    x => x.id === Number(selectedEmployeeId)
  );

  if (!emp) {
    return;
  }

  const info = panel.querySelector('#sale-employee-info');

  if (!info) {
    return;
  }

  try {
    const consumed = await window.db.employee.getDailyConsumption(
      selectedEmployeeId
    );

    const consumption = Math.min(
      Math.max(Number(consumed || 0), 0),
      100
    );

    const available = Math.max(
      100 - consumption,
      0
    );

    employeeAvailableCache = available;

    info.textContent =
      `ID: ${emp.id} · ${emp.role || 'Personal'} · ` +
      `CONSUMO REAL: $${consumption.toFixed(2)} · ` +
      `DISPONIBLE: $${available.toFixed(2)} de $100.00`;

  } catch (error) {

    console.error(
      'Error actualizando consumo del empleado:',
      error
    );

    info.textContent =
      `ID: ${emp.id} · ${emp.role || 'Personal'} · ` +
      'No se pudo consultar el consumo de hoy.';
  }

  updateEmployeeAmountDue();
}

// ==========================================================================
// A COBRAR REAL DEL EMPLEADO
// El beneficio ($100/día) y el crédito de nómina nunca deben cobrarse en
// caja: esta función calcula lo que sí hay que cobrar (si acaso) para que
// el checkout no le pida al cajero el total bruto del pedido.
// ==========================================================================
// Estimación (síncrona, con el último "disponible" consultado) de cuánto
// hay que cobrar realmente. No sustituye el cálculo autoritativo del RPC en
// el backend, solo evita pedirle caja de más al cajero en el checkout.
function estimateEmployeeAmountDue() {
  if (currentClientType !== 'employee' || !selectedEmployeeSaleType) return null;
  const { total } = cartTotals();
  if (selectedEmployeeSaleType === 'takeaway_credit') return 0;
  const benefit = Math.min(total, employeeAvailableCache);
  const extra = Math.max(total - benefit, 0);
  return selectedEmployeeExtraPayment === 'credit' ? 0 : extra;
}

function updateEmployeeAmountDue() {
  const panel = document.getElementById('employee-selector-panel');
  if (!panel) return;
  const dueInfo = panel.querySelector('#employee-amount-due-info');
  if (!dueInfo) return;

  if (currentClientType !== 'employee' || !selectedEmployeeId || !selectedEmployeeSaleType) {
    dueInfo.textContent = '';
    return;
  }

  const { total } = cartTotals();

  if (selectedEmployeeSaleType === 'takeaway_credit') {
    dueInfo.textContent = `Todo va a crédito de nómina · $0.00 a cobrar hoy.`;
    return;
  }

  const benefit = Math.min(total, employeeAvailableCache);
  const extra = Math.max(total - benefit, 0);

  if (extra === 0) {
    dueInfo.textContent = `Beneficio: ${fmt(benefit)} · Cubierto por completo · $0.00 a cobrar.`;
  } else if (selectedEmployeeExtraPayment === 'credit') {
    dueInfo.textContent = `Beneficio: ${fmt(benefit)} · Excedente a crédito de nómina: ${fmt(extra)} · $0.00 a cobrar hoy.`;
  } else {
    dueInfo.textContent = `Beneficio: ${fmt(benefit)} · A cobrar en efectivo: ${fmt(extra)}.`;
  }
}

// Refleja lo mismo dentro del modal de cobro: oculta los métodos de pago y
// el campo de efectivo cuando no hay nada que cobrar (beneficio completo o
// crédito de nómina), y muestra "A cobrar" en vez del total bruto.
function updateCheckoutModalForEmployee() {
  const dueRow = document.getElementById('checkout-employee-due');
  const dueAmountEl = document.getElementById('checkout-employee-due-amount');
  const payMethodsWrap = document.getElementById('checkout-pay-methods-wrap');
  const due = estimateEmployeeAmountDue();

  if (due == null) {
    dueRow.style.display = 'none';
    payMethodsWrap.style.display = 'block';
    cashFields.style.display = selectedPayMethod === 'efectivo' ? 'block' : 'none';
    return;
  }

  dueRow.style.display = 'flex';
  dueAmountEl.textContent = fmt(due);

  if (due === 0) {
    payMethodsWrap.style.display = 'none';
    cashFields.style.display = 'none';
  } else {
    payMethodsWrap.style.display = 'none'; // el excedente en efectivo ya se decide en "Pago del excedente"
    cashFields.style.display = 'block';
  }
}

// ==========================================================================
// AUTO-REFRESH DEL CONSUMO DIARIO
// Sondea el consumo del empleado cada pocos segundos mientras haya un
// empleado seleccionado, para no depender del refresh manual al probar
// que el backend efectivamente esté guardando/actualizando el beneficio.
// ==========================================================================
function startEmployeeConsumptionAutoRefresh() {
  stopEmployeeConsumptionAutoRefresh();
  employeeConsumptionRefreshTimer = setInterval(() => {
    if (currentClientType === 'employee' && selectedEmployeeId) {
      refreshEmployeeConsumptionDisplay();
    } else {
      stopEmployeeConsumptionAutoRefresh();
    }
  }, EMPLOYEE_CONSUMPTION_REFRESH_MS);
}

function stopEmployeeConsumptionAutoRefresh() {
  if (employeeConsumptionRefreshTimer) {
    clearInterval(employeeConsumptionRefreshTimer);
    employeeConsumptionRefreshTimer = null;
  }
}

async function loadEmployeesForSales() {
  const panel = ensureEmployeeSelector();
  try {
    employees = (await window.db.employees.getAll()).filter(e => e.active);
    const select = panel.querySelector('#sale-employee-select');
    select.innerHTML = '<option value="">Selecciona un empleado...</option>' + employees.map(e => `<option value="${e.id}">${escapeHtml(e.name)} (ID ${e.id})</option>`).join('');
    if (selectedEmployeeId && employees.some(e => e.id === selectedEmployeeId)) select.value = String(selectedEmployeeId);
  } catch (err) {
    console.error('Error cargando empleados para Ventas:', err);
    toast(err?.message || 'No se pudieron cargar los empleados.', 'error');
  }
}

function updateEmployeeSelectorVisibility() {
  const panel = ensureEmployeeSelector();
  panel.style.display = currentClientType === 'employee' ? 'block' : 'none';
  if (currentClientType !== 'employee') {
  selectedEmployeeId = null;
  selectedEmployeeSaleType = null;
  selectedEmployeeExtraPayment = null;
  stopEmployeeConsumptionAutoRefresh();

  const saleTypeSelect = panel.querySelector('#employee-sale-type');

  if (saleTypeSelect) {
    saleTypeSelect.value = '';
  }
}
  updateEmployeeAmountDue();
}


function fmt(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
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
// avisa con un toast rojo por cada uno.
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
// 1. TIPO DE CLIENTE
// ==========================================================================
btnPublic.addEventListener('click', () => setClientType('public'));
btnEmployee.addEventListener('click', () => setClientType('employee'));
btnChangeClient.addEventListener('click', () => modal.classList.add('show'));

function setClientType(type) {
  currentClientType = type;
  modal.classList.remove('show');

  if (type === 'employee') {
    badgeClientType.textContent = `Empleado (${employeeDiscountPct}% Desc)`;
    badgeClientType.style.backgroundColor = 'rgba(22, 163, 74, 0.15)';
    badgeClientType.style.color = '#16a34a';
  } else {
    badgeClientType.textContent = 'Público General';
    badgeClientType.style.backgroundColor = 'rgba(37, 99, 235, 0.15)';
    badgeClientType.style.color = '#2563eb';
  }

  updateEmployeeSelectorVisibility();
  renderCart();
}

// ==========================================================================
// 2. CARGA DE CATÁLOGO Y PROMOCIONES DESDE LA BASE DE DATOS
// ==========================================================================
async function loadCatalog() {
  try {
    const [products, promos, settings, recipesRaw, productModifierGroups, promotionModifierGroups] = await Promise.all([
      window.db.products.getAll(),
      window.db.promotions.getAll(),
      window.db.settings.getAll(),
      window.db.recipes.getAllWithStock(),
      window.db.productModifierGroups.getAll(),
      window.db.promotionModifierGroups.getAll()
    ]);
    allProducts = products.filter((p) => p.active);
    allPromotions = promos.filter((p) => p.active);
    employeeDiscountPct = Number(settings.employee_discount_pct) || 20;
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

    await loadEmployeesForSales();
    renderPromoStrip();
    renderProducts();
  } catch (err) {
    console.error(err);
    toast('No se pudo cargar el catálogo.', 'error');
  }
}

// ==========================================================================
// 3. RENDER: FRANJA DE PROMOCIONES (siempre visible, un clic para vender)
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
    card.addEventListener('click', async () => {
      const promo = allPromotions.find((p) => p.id === Number(card.dataset.id));
      if (!promo) return;

      const item = { id: promo.id, name: promo.name, itemType: 'promo', basePrice: promo.price };

      // Misma exigencia que ya aplica a productos (ver más abajo, en el
      // click de .product-card): una promo/paquete puede pedir elegir
      // salsa(s) igual que un producto (promotion_modifier_groups, tabla
      // propia sin relación con products -- ver
      // 20260901000000_promotion_modifier_groups.sql).
      const groups = promotionModifierGroupsByPromotion.get(promo.id);
      const saucesQty = groups && groups.get('Salsas');
      if (saucesQty) {
        const chosen = await showSauceSelector(saucesQty);
        if (!chosen) return;
        item.modifierIds = chosen.map((c) => c.id);
        item.modifierNames = chosen.map((c) => c.name);
      }

      addToCart(item);
    });
  });
}

// ==========================================================================
// 4. RENDER: CATÁLOGO DE PRODUCTOS
// ==========================================================================
function renderProducts() {
  const filterText = searchInput.value.trim().toLowerCase();

  if (selectedCategory === 'promo') {
    productsGrid.innerHTML = `
      <div class="empty-catalog">
        ↑ Selecciona una promoción en la franja de arriba para agregarla con un clic.
      </div>`;
    return;
  }

  const filtered = allProducts.filter((product) => {
    const matchesCategory = selectedCategory === 'all' || product.category === selectedCategory;
    const matchesSearch = product.name.toLowerCase().includes(filterText);
    return matchesCategory && matchesSearch;
  });

  if (filtered.length === 0) {
    productsGrid.innerHTML = `<div class="empty-catalog">Sin resultados.</div>`;
    return;
  }

  productsGrid.innerHTML = filtered
    .map((product) => {
      const isTracked = product.stock != null;
      const isOut = isTracked && product.stock <= 0;
      const isLow = isTracked && !isOut && product.stock <= 5;
      const avail = productAvailability[product.id];
      const isNoInsumos = avail && avail.status === 'rojo';
      const badgeClass = isOut || isNoInsumos ? 'out' : isLow ? 'low' : '';
      const stockBadge = isNoInsumos
        ? `<div class="stock-badge out">Sin insumos</div>`
        : isTracked
          ? `<div class="stock-badge ${badgeClass}">${isOut ? 'Agotado' : `Existencia: ${product.stock}`}</div>`
          : '';
      const title = isNoInsumos && avail.shortInsumo
        ? ` title="Sin insumos: falta &quot;${escapeHtml(avail.shortInsumo.name)}&quot; (${avail.shortInsumo.stock} ${escapeHtml(avail.shortInsumo.unit || '')} disponibles)"`
        : '';
      return `
      <div class="product-card ${isOut || isNoInsumos ? 'is-out-of-stock' : ''}" data-id="${product.id}"${title}>
        <h3>${escapeHtml(product.name)}</h3>
        <div class="price">${fmt(displayPrice(product))}</div>
        ${stockBadge}
      </div>
    `;
    })
    .join('');

  productsGrid.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', async (ev) => {
      const product = allProducts.find((p) => p.id === Number(card.dataset.id));
      if (!product) return;
      if (product.stock != null && product.stock <= 0) {
        toast(`"${product.name}" no tiene existencia disponible.`, 'error');
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

      const item = {
        id: product.id,
        name: product.name,
        itemType: 'product',
        basePrice: product.price,
        employeePrice: product.employee_price,
        stock: product.stock
      };

      // Si el producto pertenece al grupo "Salsas" (ALITAS/BONELESS, o un
      // combo que pida más de una) se exige elegir salsa(s) antes de
      // agregarlo -- mismo requisito que ya aplica en Comandas (ver
      // product_modifier_groups.qty).
      const groups = productModifierGroupsByProduct.get(product.id);
      const saucesQty = groups && groups.get('Salsas');
      if (saucesQty) {
        const chosen = await showSauceSelector(saucesQty);
        if (!chosen) return;
        item.modifierIds = chosen.map((c) => c.id);
        item.modifierNames = chosen.map((c) => c.name);
      }

      addToCart(item, qty);
    });
  });
}

function displayPrice(product) {
  if (currentClientType === 'employee') {
    if (product.employee_price != null) return product.employee_price;
    return product.price * (1 - employeeDiscountPct / 100);
  }
  return product.price;
}

document.getElementById('categories-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-btn');
  if (!btn) return;
  document.querySelectorAll('.cat-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  selectedCategory = btn.dataset.category;
  renderPromoStrip();
  renderProducts();
});

searchInput.addEventListener('input', () => renderProducts());

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ==========================================================================
// SELECTOR DE SALSA -- mismo patrón que comandas-renderer.js (modal vanilla
// creado una sola vez, reusado, resuelto vía Promise). count controla
// cuántas salsas hay que elegir (más de 1 para un combo con
// product_modifier_groups.qty > 1): "Agregar" queda deshabilitado hasta
// elegir exactamente esa cantidad. Reusa las clases .sauce-selector-*/
// .modal-overlay ya definidas en sales.css (agregadas para el mismo
// selector en comandas).
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
// 5. CARRITO
// ==========================================================================
// Existencia disponible ahora mismo para un producto (null = sin control/ilimitado).
function stockFor(id) {
  const product = allProducts.find((p) => p.id === id);
  return product ? product.stock : null;
}

function addToCart(item, qty = 1) {
  // Un producto/promo con price NULL o 0 en el catálogo (mal cargado) no debe
  // poder colarse a una venta real cobrando $0 -- ver mapCartItems en db.js,
  // que hace `Number(item.price) || 0` sin validar, y process_sale, que
  // multiplica unit_price*quantity tal cual sin rechazar 0.
  if (!(Number(item.basePrice) > 0)) {
    toast(`"${item.name}" no tiene un precio válido configurado. Revisa el catálogo antes de venderlo.`, 'error');
    return;
  }
  qty = Math.max(1, Math.min(999, Math.floor(Number(qty)) || 1));
  const modifierKey = (i) => (i.modifierIds || []).slice().sort((a, b) => a - b).join(',');
  const existing = cart.find((i) => i.id === item.id && i.itemType === item.itemType && modifierKey(i) === modifierKey(item));
  const currentQty = existing ? existing.quantity : 0;
  const stock = item.itemType === 'product' ? stockFor(item.id) : null;

  if (stock != null && currentQty + qty > stock) {
    toast(`Solo quedan ${stock} en existencia de "${item.name}".`, 'error');
    qty = stock - currentQty;
    if (qty <= 0) return;
  }

  const avail = item.itemType === 'product' ? productAvailability[item.id] : null;
  if (avail && avail.maxSellable != null && currentQty + qty > avail.maxSellable) {
    toast(`Solo alcanza el insumo para ${avail.maxSellable} de "${item.name}".`, 'error');
    qty = avail.maxSellable - currentQty;
    if (qty <= 0) return;
  }

  if (existing) {
    existing.quantity += qty;
  } else {
    cart.push({ ...item, quantity: qty });
  }
  renderCart();
}

// ==========================================================================
// CANTIDAD POR ÍNDICE -- reemplaza al viejo updateQuantity(id,itemType,delta):
// el índice en cart[] es estable entre renders (cart solo cambia al agregar/
// quitar, siempre seguido de un renderCart() que reconstruye los índices de
// los botones/inputs), y es lo que necesitan tanto el input editable como
// los botones +5/+10 y el teclado numérico.
// ==========================================================================
function setQuantity(index, qty) {
  const item = cart[index];
  if (!item) return;
  qty = Math.floor(Number(qty));
  if (!Number.isFinite(qty) || qty < 1) qty = 1;
  if (qty > 999) qty = 999;

  if (item.itemType === 'product') {
    const stock = stockFor(item.id);
    if (stock != null && qty > stock) {
      toast(`Solo quedan ${stock} en existencia de "${item.name}".`, 'error');
      qty = Math.max(1, stock);
    }
    const avail = productAvailability[item.id];
    if (avail && avail.maxSellable != null && qty > avail.maxSellable) {
      toast(`Solo alcanza el insumo para ${avail.maxSellable} de "${item.name}".`, 'error');
      qty = Math.max(1, avail.maxSellable);
    }
  }

  item.quantity = qty;
  renderCart();
}

// A diferencia de setQuantity, un delta negativo que llega a 0 quita el item
// (mismo comportamiento que tenía el botón "-" antes de este cambio).
function addQuantity(index, delta) {
  const item = cart[index];
  if (!item) return;
  const newQty = item.quantity + delta;
  if (newQty <= 0) {
    removeAtIndex(index);
    return;
  }
  setQuantity(index, newQty);
}

function updateQtyDirect(index, newVal) {
  setQuantity(index, newVal);
}

function removeAtIndex(index) {
  if (!cart[index]) return;
  cart.splice(index, 1);
  renderCart();
}

// Atajos de teclado +/- sobre "el item seleccionado" (ver common.js): el
// input de cantidad con foco cuenta como seleccionado; si ninguno tiene
// foco, se usa el último item agregado. Enter con buffer numérico pendiente
// aplica esa cantidad al último item agregado.
window.__whQtyHooks = {
  adjustSelected(delta) {
    const idx = lastFocusedQtyIndex != null && cart[lastFocusedQtyIndex] ? lastFocusedQtyIndex : cart.length - 1;
    if (idx < 0 || !cart[idx]) return;
    addQuantity(idx, delta);
  },
  applyToLast(qty) {
    const idx = cart.length - 1;
    if (idx < 0) return;
    setQuantity(idx, qty);
  }
};

function effectivePrice(item) {
  if (item.itemType === 'promo') return item.basePrice;
  if (currentClientType === 'employee') {
    if (item.employeePrice != null) return item.employeePrice;
    return item.basePrice * (1 - employeeDiscountPct / 100);
  }
  return item.basePrice;
}

function renderCart() {
  if (cart.length === 0) {
    cartItemsContainer.innerHTML = `
      <div class="cart-empty-state">
        <p>La orden está vacía</p>
        <span>Selecciona productos o promociones del catálogo</span>
      </div>
    `;
    btnCheckout.disabled = true;
    updateCartSummary();
    return;
  }

  btnCheckout.disabled = false;
  cartItemsContainer.innerHTML = cart
    .map((item, index) => {
      const price = effectivePrice(item);
      const stock = item.itemType === 'product' ? stockFor(item.id) : null;
      let stockLine = '';
      if (stock != null) {
        const remaining = stock - item.quantity;
        const cls = remaining <= 0 ? 'out' : remaining <= 5 ? 'low' : '';
        stockLine = `<div class="cart-item-stock ${cls}">Disponibles después de esta venta: ${Math.max(0, remaining)}</div>`;
      }
      const modifierLine = (item.modifierNames || []).length
        ? item.modifierNames.map((name) => `<div class="cart-item-modifiers">• ${escapeHtml(name)}</div>`).join('')
        : '';
      return `
      <div class="cart-item ${item.itemType === 'promo' ? 'is-promo' : ''}">
        <div class="cart-item-info">
          <h4>${escapeHtml(item.name)}</h4>
          ${item.itemType === 'promo' ? '<span class="promo-flag">PROMOCIÓN</span>' : ''}
          <span class="line-price">${fmt(price * item.quantity)}</span>
          ${modifierLine}
          ${stockLine}
        </div>
        <div class="cart-item-controls">
          <button class="btn-qty btn-minus" data-index="${index}">−</button>
          <input type="number" class="qty-input" min="1" max="999" value="${item.quantity}" data-index="${index}">
          <button class="btn-qty btn-plus" data-index="${index}">+</button>
          <button class="qty-fast-btn" data-index="${index}" data-delta="5" title="Agregar 5 (Ctrl++)">+5</button>
          <button class="qty-fast-btn" data-index="${index}" data-delta="10" title="Agregar 10 de un jalón">+10</button>
          <button class="btn-remove" data-index="${index}" title="Quitar">✕</button>
        </div>
      </div>
    `;
    })
    .join('');

  cartItemsContainer.querySelectorAll('.btn-minus').forEach((b) => {
    b.addEventListener('click', () => addQuantity(Number(b.dataset.index), -1));
  });
  cartItemsContainer.querySelectorAll('.btn-plus').forEach((b) => {
    b.addEventListener('click', () => addQuantity(Number(b.dataset.index), 1));
  });
  cartItemsContainer.querySelectorAll('.qty-fast-btn').forEach((b) => {
    b.addEventListener('click', () => addQuantity(Number(b.dataset.index), Number(b.dataset.delta)));
  });
  cartItemsContainer.querySelectorAll('.btn-remove').forEach((b) => {
    b.addEventListener('click', () => removeAtIndex(Number(b.dataset.index)));
  });
  cartItemsContainer.querySelectorAll('.qty-input').forEach((input) => {
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
      input.blur();
      openQtyKeypad(cart[idx] ? cart[idx].quantity : 1, (val) => updateQtyDirect(idx, val));
    });
  });

  updateCartSummary();
}

function cartTotals() {
  const subtotal = cart.reduce((sum, item) => sum + item.basePrice * item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + effectivePrice(item) * item.quantity, 0);
  const discount = subtotal - total;
  return { subtotal, discount, total };
}

function updateCartSummary() {
  const { subtotal, discount, total } = cartTotals();

  if (currentClientType === 'employee' && discount > 0.004) {
    rowDiscount.style.display = 'flex';
  } else {
    rowDiscount.style.display = 'none';
  }

  subtotalEl.textContent = fmt(subtotal);
  discountEl.textContent = `-${fmt(discount)}`;
  totalEl.textContent = fmt(total);
  updateEmployeeAmountDue();
}

btnClearCart.addEventListener('click', () => {
  cart = [];
  renderCart();
});

// ==========================================================================
// 6. CHECKOUT / COBRO
// ==========================================================================
btnCheckout.addEventListener('click', () => {
  if (cart.length === 0) return;
  const { total } = cartTotals();
  checkoutTotalAmount.textContent = fmt(total);
  amountReceivedInput.value = '';
  changeAmountEl.textContent = fmt(0);
  selectedPayMethod = 'efectivo';
  document.querySelectorAll('.pay-method-btn').forEach((b) => b.classList.toggle('active', b.dataset.method === 'efectivo'));

  splitPaymentActive = false;
  chkSplitPayment.checked = false;
  splitPaymentFields.style.display = 'none';
  payMethodsButtonsEl.style.display = 'grid';
  splitEfectivoInput.value = '';
  splitTarjetaInput.value = '';
  splitTransferenciaInput.value = '';
  updateSplitRemaining();

  updateCheckoutModalForEmployee();
  checkoutModal.classList.add('show');
  amountReceivedInput.focus();
});

btnCancelCheckout.addEventListener('click', () => checkoutModal.classList.remove('show'));

document.querySelectorAll('.pay-method-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pay-method-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedPayMethod = btn.dataset.method;
    updateCheckoutModalForEmployee();
  });
});

amountReceivedInput.addEventListener('input', () => {
  const due = estimateEmployeeAmountDue();
  const amountDue = due != null ? due : cartTotals().total;
  const received = Number(amountReceivedInput.value) || 0;
  const change = received - amountDue;
  changeAmountEl.textContent = fmt(change > 0 ? change : 0);
});

btnConfirmCheckout.addEventListener('click', async () => {
  const { subtotal, discount, total } = cartTotals();

  // Defensa en profundidad: addToCart ya rechaza precios inválidos al
  // agregar, pero si por algún motivo el carrito llegara aquí con subtotal
  // <= 0 (precio en $0, catálogo mal cargado) no debe registrarse una venta
  // "completada" por $0 -- aborta antes de llamar a process_sale.
  if (!(subtotal > 0)) {
    toast('El carrito no tiene un total válido. Revisa los precios de los artículos.', 'error');
    return;
  }

  let amountReceived = null;
  let changeGiven = null;

  let employeeDailyAvailable = 100;
  let employeeBenefitAmount = 0;
  let employeeExtraAmount = 0;

  // ================================================================
  // VALIDACIONES DE EMPLEADO
  // ================================================================

  if (currentClientType === 'employee' && !selectedEmployeeId) {
    toast(
      'Selecciona el empleado que realiza la compra.',
      'error'
    );

    btnConfirmCheckout.disabled = false;
    return;
  }

  if (
    currentClientType === 'employee' &&
    !selectedEmployeeSaleType
  ) {
    toast(
      'Selecciona el tipo de consumo: $100 diario o Para llevar - Crédito.',
      'error'
    );

    btnConfirmCheckout.disabled = false;
    return;
  }

  // ================================================================
  // CALCULAR BENEFICIO DIARIO DEL EMPLEADO
  // ================================================================

  if (
    currentClientType === 'employee' &&
    selectedEmployeeId &&
    selectedEmployeeSaleType === 'daily_100'
  ) {
    try {
      const consumed =
        await window.db.employee.getDailyConsumption(
          selectedEmployeeId
        );

      employeeDailyAvailable = Math.max(
        100 - Number(consumed || 0),
        0
      );

      employeeBenefitAmount = Math.min(
        total,
        employeeDailyAvailable
      );

      employeeExtraAmount = Math.max(
        total - employeeBenefitAmount,
        0
      );

    } catch (error) {
      console.error(
        'Error consultando consumo del empleado:',
        error
      );

      toast(
        'No se pudo consultar el consumo diario del empleado.',
        'error'
      );

      btnConfirmCheckout.disabled = false;
      return;
    }
  }

  // ================================================================
  // VALIDAR FORMA DE PAGO DEL EXCEDENTE
  // ================================================================

  if (
    currentClientType === 'employee' &&
    selectedEmployeeSaleType === 'daily_100' &&
    employeeExtraAmount > 0 &&
    !selectedEmployeeExtraPayment
  ) {
    toast(
      `El empleado tiene $${employeeDailyAvailable.toFixed(2)} ` +
      `disponibles y el excedente es de $${employeeExtraAmount.toFixed(2)}. ` +
      'Selecciona Efectivo o Crédito semanal.',
      'error'
    );

    btnConfirmCheckout.disabled = false;
    return;
  }

  // ================================================================
  // MONTO REAL A COBRAR
  // El beneficio ($100/día) y el excedente a crédito de nómina nunca pasan
  // por caja: solo se cobra el excedente en efectivo, y solo si el
  // consumo es 'daily_100' con employeeExtraPayment = 'cash'. 'takeaway_credit'
  // siempre es $0 a cobrar (todo va a crédito semanal).
  // ================================================================

  const amountDue =
    currentClientType === 'employee'
      ? (selectedEmployeeSaleType === 'takeaway_credit' ? 0 : employeeExtraAmount)
      : total;

  // ================================================================
  // MÉTODO DE PAGO REAL
  // Sustituye el botón Efectivo/Tarjeta/Transferencia cuando la venta es
  // de empleado: ese selector no aplica a lo que en realidad pasó con el
  // dinero (beneficio comido / crédito de nómina), así que se fuerza un
  // valor que corte de caja y reportes puedan reconocer sin ambigüedad.
  // ================================================================

  let effectivePaymentMethod = selectedPayMethod;

  if (currentClientType === 'employee') {
    if (selectedEmployeeSaleType === 'takeaway_credit') {
      effectivePaymentMethod = 'credito_nomina';
    } else if (amountDue === 0) {
      effectivePaymentMethod = 'beneficio_empleado';
    } else if (selectedEmployeeExtraPayment === 'credit') {
      effectivePaymentMethod = 'credito_nomina';
    } else {
      effectivePaymentMethod = 'efectivo';
    }
  }

  // ================================================================
  // PAGO COMBINADO (Combinar métodos de pago)
  // Solo aplica a público general -- el checkbox vive dentro de
  // checkout-pay-methods-wrap, que updateCheckoutModalForEmployee oculta
  // por completo en ventas de empleado, así que currentClientType===
  // 'employee' con splitPaymentActive=true no debería poder ocurrir; se
  // guarda igual como defensa en profundidad.
  // ================================================================

  let splitPayments = null;

  if (splitPaymentActive && currentClientType !== 'employee') {
    const splitAmounts = {
      efectivo: Number(splitEfectivoInput.value) || 0,
      tarjeta: Number(splitTarjetaInput.value) || 0,
      transferencia: Number(splitTransferenciaInput.value) || 0
    };

    splitPayments = Object.entries(splitAmounts)
      .filter(([, amount]) => amount > 0)
      .map(([method, amount]) => ({ method, amount: Math.round(amount * 100) / 100 }));

    if (splitPayments.length < 2) {
      toast(
        'Captura al menos 2 métodos de pago para combinar, o desactiva "Combinar métodos de pago".',
        'error'
      );

      btnConfirmCheckout.disabled = false;
      return;
    }

    const splitSum = splitPayments.reduce((sum, p) => sum + p.amount, 0);

    if (Math.abs(splitSum - amountDue) > 0.004) {
      toast(
        `La suma de los métodos de pago (${fmt(splitSum)}) no coincide con el total a cobrar (${fmt(amountDue)}).`,
        'error'
      );

      btnConfirmCheckout.disabled = false;
      return;
    }

    amountReceived = amountDue;
    changeGiven = 0;
  } else if (amountDue === 0) {
    amountReceived = 0;
    changeGiven = 0;
  } else if (effectivePaymentMethod === 'efectivo') {
    amountReceived =
      Number(amountReceivedInput.value) || 0;

    if (amountReceived < amountDue) {
      toast(
        'El monto recibido es menor al monto a cobrar.',
        'error'
      );

      btnConfirmCheckout.disabled = false;
      return;
    }

    changeGiven = amountReceived - amountDue;
  }

  // ================================================================
  // PAYLOAD
  // ================================================================

  const payload = {
    clientType: currentClientType,

    employeeId:
      currentClientType === 'employee'
        ? selectedEmployeeId
        : null,

    employeeSaleType:
      currentClientType === 'employee'
        ? selectedEmployeeSaleType
        : null,

    employeeExtraPayment:
      currentClientType === 'employee'
        ? selectedEmployeeExtraPayment
        : null,

    subtotal,
    discount,
    total,

    paymentMethod: splitPayments ? 'mixto' : effectivePaymentMethod,

    amountReceived,
    changeGiven,

    payments: splitPayments,

    items: cart.map((item) => ({
      id: item.id,
      name: item.name,
      itemType: item.itemType,
      price: effectivePrice(item),
      quantity: item.quantity,
      modifierIds: item.modifierIds && item.modifierIds.length ? item.modifierIds : undefined
    }))
  };

  btnConfirmCheckout.disabled = true;
  try {
    const sale = await window.db.sales.create(payload);
    folioPreview.textContent = `Último ticket: ${sale.folio}`;
    toast(`Venta registrada: ${sale.folio}`, 'success');
    alertLowStockInsumos();
    refreshAvailability();

 if (chkPrint.checked) {
  try {
    const result = await window.printerAPI.printTicket(sale.id);

    console.log('Resultado de impresión:', result);

    if (result && result.success) {
      toast('Ticket enviado a la impresora.', 'success');
    } else if (result && result.reason === 'cancelled') {
      console.log('Impresión cancelada por el usuario.');
    } else if (result && result.reason === 'disabled') {
      console.log('Impresión deshabilitada en Ajustes.');
    } else {
      console.warn('Impresión no completada:', result);
    }

  } catch (printErr) {
    console.error('Error de impresión:', printErr);
  }
}

    cart = [];
    renderCart();
    checkoutModal.classList.remove('show');

    if (currentClientType === 'employee' && selectedEmployeeId) {
      await refreshEmployeeConsumptionDisplay();
    }
  } catch (err) {
    console.error(err);
    // Si el backend rechazó la venta por falta de existencia, se muestra el
    // motivo real (en vez de un mensaje genérico) y se refresca el catálogo
    // para que el contador de existencia quede al día.
    toast(err && err.message ? err.message : 'No se pudo registrar la venta.', 'error');
    loadCatalog();
  } finally {
    btnConfirmCheckout.disabled = false;
  }
});

// ==========================================================================
// NAVEGACIÓN
// ==========================================================================
btnBack.addEventListener('click', () => {
  if (window.api && window.api.sendAction) {
    window.api.sendAction('open-menu');
  } else {
    window.location.href = 'index.html';
  }
});

// ==========================================================================
// INICIALIZACIÓN
// ==========================================================================
document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardPermission('ventas', 'can_view');
  if (!session) return;
  folioPreview.textContent = session.displayName;
  ensureEmployeeSelector();
  updateEmployeeSelectorVisibility();
  loadCatalog();
  
});