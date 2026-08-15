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
let cart = [];
let selectedCategory = 'all';
let selectedPayMethod = 'efectivo';

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

});

panel.querySelector('#employee-extra-payment').addEventListener('change', (e) => {

    selectedEmployeeExtraPayment = e.target.value || null;

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
    const [products, promos, settings] = await Promise.all([
      window.db.products.getAll(),
      window.db.promotions.getAll(),
      window.db.settings.getAll()
    ]);
    allProducts = products.filter((p) => p.active);
    allPromotions = promos.filter((p) => p.active);
    employeeDiscountPct = Number(settings.employee_discount_pct) || 20;
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
    card.addEventListener('click', () => {
      const promo = allPromotions.find((p) => p.id === Number(card.dataset.id));
      if (promo) {
        addToCart({ id: promo.id, name: promo.name, itemType: 'promo', basePrice: promo.price });
      }
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
      const badgeClass = isOut ? 'out' : isLow ? 'low' : '';
      const stockBadge = isTracked
        ? `<div class="stock-badge ${badgeClass}">${isOut ? 'Agotado' : `Existencia: ${product.stock}`}</div>`
        : '';
      return `
      <div class="product-card ${isOut ? 'is-out-of-stock' : ''}" data-id="${product.id}">
        <h3>${escapeHtml(product.name)}</h3>
        <div class="price">${fmt(displayPrice(product))}</div>
        ${stockBadge}
      </div>
    `;
    })
    .join('');

  productsGrid.querySelectorAll('.product-card').forEach((card) => {
    card.addEventListener('click', () => {
      const product = allProducts.find((p) => p.id === Number(card.dataset.id));
      if (!product) return;
      if (product.stock != null && product.stock <= 0) {
        toast(`"${product.name}" no tiene existencia disponible.`, 'error');
        return;
      }
      addToCart({
        id: product.id,
        name: product.name,
        itemType: 'product',
        basePrice: product.price,
        employeePrice: product.employee_price,
        stock: product.stock
      });
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
// 5. CARRITO
// ==========================================================================
// Existencia disponible ahora mismo para un producto (null = sin control/ilimitado).
function stockFor(id) {
  const product = allProducts.find((p) => p.id === id);
  return product ? product.stock : null;
}

function addToCart(item) {
  const existing = cart.find((i) => i.id === item.id && i.itemType === item.itemType);
  const currentQty = existing ? existing.quantity : 0;
  const stock = item.itemType === 'product' ? stockFor(item.id) : null;

  if (stock != null && currentQty + 1 > stock) {
    toast(`Solo quedan ${stock} en existencia de "${item.name}".`, 'error');
    return;
  }

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({ ...item, quantity: 1 });
  }
  renderCart();
}

function updateQuantity(id, itemType, delta) {
  const item = cart.find((i) => i.id === id && i.itemType === itemType);
  if (!item) return;

  if (delta > 0 && itemType === 'product') {
    const stock = stockFor(id);
    if (stock != null && item.quantity + delta > stock) {
      toast(`Solo quedan ${stock} en existencia de "${item.name}".`, 'error');
      return;
    }
  }

  item.quantity += delta;
  if (item.quantity <= 0) {
    cart = cart.filter((i) => !(i.id === id && i.itemType === itemType));
  }
  renderCart();
}

function removeFromCart(id, itemType) {
  cart = cart.filter((i) => !(i.id === id && i.itemType === itemType));
  renderCart();
}

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
    .map((item) => {
      const price = effectivePrice(item);
      const stock = item.itemType === 'product' ? stockFor(item.id) : null;
      let stockLine = '';
      if (stock != null) {
        const remaining = stock - item.quantity;
        const cls = remaining <= 0 ? 'out' : remaining <= 5 ? 'low' : '';
        stockLine = `<div class="cart-item-stock ${cls}">Disponibles después de esta venta: ${Math.max(0, remaining)}</div>`;
      }
      return `
      <div class="cart-item ${item.itemType === 'promo' ? 'is-promo' : ''}">
        <div class="cart-item-info">
          <h4>${escapeHtml(item.name)}</h4>
          ${item.itemType === 'promo' ? '<span class="promo-flag">PROMOCIÓN</span>' : ''}
          <span class="line-price">${fmt(price * item.quantity)}</span>
          ${stockLine}
        </div>
        <div class="cart-item-controls">
          <button class="btn-qty btn-minus" data-id="${item.id}" data-type="${item.itemType}">−</button>
          <span>${item.quantity}</span>
          <button class="btn-qty btn-plus" data-id="${item.id}" data-type="${item.itemType}">+</button>
          <button class="btn-remove" data-id="${item.id}" data-type="${item.itemType}" title="Quitar">✕</button>
        </div>
      </div>
    `;
    })
    .join('');

  cartItemsContainer.querySelectorAll('.btn-minus').forEach((b) => {
    b.addEventListener('click', () => updateQuantity(Number(b.dataset.id), b.dataset.type, -1));
  });
  cartItemsContainer.querySelectorAll('.btn-plus').forEach((b) => {
    b.addEventListener('click', () => updateQuantity(Number(b.dataset.id), b.dataset.type, 1));
  });
  cartItemsContainer.querySelectorAll('.btn-remove').forEach((b) => {
    b.addEventListener('click', () => removeFromCart(Number(b.dataset.id), b.dataset.type));
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
  cashFields.style.display = 'block';
  checkoutModal.classList.add('show');
  amountReceivedInput.focus();
});

btnCancelCheckout.addEventListener('click', () => checkoutModal.classList.remove('show'));

document.querySelectorAll('.pay-method-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pay-method-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedPayMethod = btn.dataset.method;
    cashFields.style.display = selectedPayMethod === 'efectivo' ? 'block' : 'none';
  });
});

amountReceivedInput.addEventListener('input', () => {
  const { total } = cartTotals();
  const received = Number(amountReceivedInput.value) || 0;
  const change = received - total;
  changeAmountEl.textContent = fmt(change > 0 ? change : 0);
});

btnConfirmCheckout.addEventListener('click', async () => {
  const { subtotal, discount, total } = cartTotals();

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
  // COBRO EN EFECTIVO
  // ================================================================

  if (selectedPayMethod === 'efectivo') {
    amountReceived =
      Number(amountReceivedInput.value) || 0;

    if (amountReceived < total) {
      toast(
        'El monto recibido es menor al total.',
        'error'
      );

      btnConfirmCheckout.disabled = false;
      return;
    }

    changeGiven = amountReceived - total;
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

    paymentMethod: selectedPayMethod,

    amountReceived,
    changeGiven,

    items: cart.map((item) => ({
      id: item.id,
      name: item.name,
      itemType: item.itemType,
      price: effectivePrice(item),
      quantity: item.quantity
    }))
  };
  console.log('DEBUG PAYLOAD VENTA EMPLEADO:', {
  subtotal: payload.subtotal,
  discount: payload.discount,
  total: payload.total,
  employeeId: payload.employeeId,
  employeeSaleType: payload.employeeSaleType,
  employeeExtraPayment: payload.employeeExtraPayment,
  paymentMethod: payload.paymentMethod,
  items: payload.items
});

  btnConfirmCheckout.disabled = true;
  try {
    
    const sale = await window.db.sales.create(payload);
    console.log('DEBUG PAYLOAD VENTA:', JSON.stringify(payload, null, 2));
    folioPreview.textContent = `Último ticket: ${sale.folio}`;
    toast(`Venta registrada: ${sale.folio}`, 'success');

 if (chkPrint.checked) {
  try {
    const result = await window.printerAPI.printTicket(sale.id);

    console.log('Resultado de impresión:', result);

    if (result && result.success) {
      toast('Ticket enviado a la impresora.', 'success');
    } else if (result && result.reason === 'cancelled') {
      console.log('Impresión cancelada por el usuario.');
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
  const session = await window.auth.getSession();
  if (!session) {
    window.api.sendAction('open-login');
    return;
  }
  if (!['admin', 'cajero'].includes(session.role)) {
    alert('No tienes permiso para acceder a Ventas.');
    window.api.sendAction('open-menu');
    return;
  }
  folioPreview.textContent = session.displayName;
  ensureEmployeeSelector();
  updateEmployeeSelectorVisibility();
  loadCatalog();
  
});