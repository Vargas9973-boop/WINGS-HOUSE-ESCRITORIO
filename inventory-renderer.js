let inventory = [];
let currentFilter = { search: '', category: '', sort: 'name' };
let productsUsingInsumo = {}; // insumoId -> [{ id, name }] -- ver loadInventory()

// Únicas unidades permitidas -- sin texto libre, para que la receta del
// catálogo (catalog-renderer.js) siempre pueda mostrar/guardar en una
// unidad consistente sin adivinar variantes ("kilos", "PZ", "Lt", etc.).
const ALLOWED_UNITS = ['pz', 'kg', 'g', 'mg', 'L', 'ml', 'orden', 'porción'];

// Llena el <select> de unidad. Si el insumo ya tenía guardada una unidad
// fuera de la lista (dato legado, p.ej. "pza"), se agrega como opción aparte
// marcada para no perderla/cambiarla en silencio -- pero saveItem() exige
// elegir una de las permitidas para poder guardar.
function renderUnitOptions(currentUnit) {
  const select = document.getElementById('item-unit');
  const isLegacy = currentUnit && !ALLOWED_UNITS.includes(currentUnit);
  select.innerHTML = ALLOWED_UNITS.map((u) => `<option value="${u}">${u}</option>`).join('') +
    (isLegacy ? `<option value="${escapeHtml(currentUnit)}">${escapeHtml(currentUnit)} (unidad antigua, cámbiala)</option>` : '');
  select.value = currentUnit || 'pz';
}

async function loadInventory() {
  const [items, recipesRaw] = await Promise.all([
    window.db.inventory.getAll(),
    window.db.recipes.getAllWithStock().catch((err) => {
      console.error('No se pudo cargar el uso de insumos en recetas:', err);
      return [];
    })
  ]);
  inventory = items;
  productsUsingInsumo = {};
  (recipesRaw || []).forEach((r) => {
    if (!r.product) return;
    if (!productsUsingInsumo[r.insumo_id]) productsUsingInsumo[r.insumo_id] = [];
    productsUsingInsumo[r.insumo_id].push(r.product);
  });
  renderCategoryOptions();
  renderKpis();
  renderLowStockBanner();
  renderTable();
}

function renderCategoryOptions() {
  const categories = Array.from(new Set(inventory.map((i) => i.category).filter(Boolean))).sort();

  const filterSelect = document.getElementById('filter-category');
  const previousValue = filterSelect.value;
  filterSelect.innerHTML = '<option value="">Todas</option>' +
    categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  filterSelect.value = categories.includes(previousValue) ? previousValue : '';

  document.getElementById('category-suggestions').innerHTML =
    categories.map((c) => `<option value="${escapeHtml(c)}">`).join('');
}

function renderKpis() {
  const totalItems = inventory.length;
  const lowStockItems = inventory.filter((i) => Number(i.stock) <= Number(i.min_stock));
  const totalValue = inventory.reduce((sum, i) => sum + Number(i.stock) * Number(i.cost_per_unit || 0), 0);

  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Insumos registrados</div>
      <div class="kpi-value">${totalItems}</div>
    </div>
    <div class="kpi-card ${lowStockItems.length > 0 ? 'danger' : 'success'}">
      <div class="kpi-label">Insumos en mínimo o por debajo</div>
      <div class="kpi-value">${lowStockItems.length}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Valor total en stock</div>
      <div class="kpi-value">${fmtMoney(totalValue)}</div>
    </div>
  `;
}

function renderLowStockBanner() {
  const banner = document.getElementById('low-stock-banner');
  const lowStockItems = inventory.filter((i) => Number(i.stock) <= Number(i.min_stock));
  if (lowStockItems.length === 0) {
    banner.innerHTML = '';
    return;
  }
  const names = lowStockItems.map((i) => `${escapeHtml(i.name)} (${i.stock} ${escapeHtml(i.unit || '')})`).join(', ');
  banner.innerHTML = `
    <div class="low-stock-banner">
      ⚠️ <strong>Stock bajo o agotado:</strong> ${names}
    </div>
  `;
}

function applyFilters(items) {
  let result = items.slice();

  if (currentFilter.search) {
    const q = currentFilter.search.toLowerCase();
    result = result.filter((i) => i.name.toLowerCase().includes(q));
  }
  if (currentFilter.category) {
    result = result.filter((i) => i.category === currentFilter.category);
  }

  switch (currentFilter.sort) {
    case 'stock-asc':
      result.sort((a, b) => Number(a.stock) - Number(b.stock));
      break;
    case 'stock-desc':
      result.sort((a, b) => Number(b.stock) - Number(a.stock));
      break;
    case 'low-first':
      result.sort((a, b) => {
        const aLow = Number(a.stock) <= Number(a.min_stock) ? 0 : 1;
        const bLow = Number(b.stock) <= Number(b.min_stock) ? 0 : 1;
        if (aLow !== bLow) return aLow - bLow;
        return a.name.localeCompare(b.name);
      });
      break;
    default:
      result.sort((a, b) => a.name.localeCompare(b.name));
  }

  return result;
}

function renderTable() {
  const tbody = document.getElementById('inventory-tbody');
  const items = applyFilters(inventory);

  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state">Sin insumos que coincidan con el filtro.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = items
    .map((item) => {
      const low = Number(item.stock) <= Number(item.min_stock);
      const usedBy = productsUsingInsumo[item.id] || [];
      const usedByCell = usedBy.length === 0
        ? '<span style="color:var(--text-muted)">Ninguno</span>'
        : `<span class="tag inactive" title="${escapeHtml(usedBy.map((p) => p.name).join(', '))}">${usedBy.length} producto${usedBy.length === 1 ? '' : 's'}</span>`;
      return `
      <tr class="${low ? 'row-danger' : ''}">
        <td>${low ? '⚠️ ' : ''}${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.category || '—')}</td>
        <td>${item.stock}</td>
        <td>${item.min_stock}</td>
        <td>${escapeHtml(item.unit || '')}</td>
        <td>${fmtMoney(item.cost_per_unit)}</td>
        <td><span class="tag ${low ? 'low' : 'ok'}">${low ? 'Stock bajo' : 'OK'}</span></td>
        <td>${usedByCell}</td>
        <td class="row-actions">
          <button class="btn btn-outline btn-sm" data-action="add-stock" data-id="${item.id}">+ Stock</button>
          <button class="btn btn-outline btn-sm" data-action="history" data-id="${item.id}">Historial</button>
          <button class="btn btn-outline btn-sm" data-action="edit" data-id="${item.id}">Editar</button>
          <button class="btn btn-danger btn-sm" data-action="remove" data-id="${item.id}">Eliminar</button>
        </td>
      </tr>
    `;
    })
    .join('');
}

// ==========================================================================
// MODAL NUEVO / EDITAR INSUMO
// ==========================================================================
function openItemModal(id = null) {
  const item = id ? inventory.find((x) => x.id === id) : null;
  document.getElementById('item-modal-title').textContent = item ? 'Editar insumo' : 'Nuevo insumo';
  document.getElementById('item-stock-label').textContent = item ? 'Existencia actual' : 'Existencia inicial';
  document.getElementById('item-id').value = item ? item.id : '';
  document.getElementById('item-name').value = item ? item.name : '';
  document.getElementById('item-category').value = item ? item.category || '' : '';
  renderUnitOptions(item ? item.unit || '' : '');
  document.getElementById('item-stock').value = item ? item.stock : '';
  document.getElementById('item-min-stock').value = item ? item.min_stock : '';
  document.getElementById('item-cost').value = item ? item.cost_per_unit : '';
  openModal('item-modal');
}

async function saveItem() {
  const btn = document.getElementById('btn-save-item');
  const id = document.getElementById('item-id').value;
  const name = document.getElementById('item-name').value.trim();
  const category = document.getElementById('item-category').value.trim();
  const unit = document.getElementById('item-unit').value;
  const stock = document.getElementById('item-stock').value;
  const min_stock = document.getElementById('item-min-stock').value;
  const cost_per_unit = document.getElementById('item-cost').value;

  if (!name) {
    toast('El nombre es obligatorio.', 'error');
    return;
  }
  if (!ALLOWED_UNITS.includes(unit)) {
    toast(`Unidad no válida: "${unit}". Elige una de: ${ALLOWED_UNITS.join(', ')}.`, 'error');
    return;
  }
  if (stock !== '' && Number(stock) < 0) {
    toast('La existencia no puede ser negativa.', 'error');
    return;
  }

  const data = {
    name,
    category: category || null,
    unit,
    stock: Number(stock) || 0,
    min_stock: Number(min_stock) || 0,
    cost_per_unit: Number(cost_per_unit) || 0
  };

  btn.disabled = true;
  try {
    if (id) {
      await window.db.inventory.update(Number(id), data);
      toast('Insumo actualizado.', 'success');
    } else {
      await window.db.inventory.create(data);
      toast('Insumo creado.', 'success');
    }
    closeModal('item-modal');
    await loadInventory();
  } catch (err) {
    console.error('ERROR AL GUARDAR INSUMO:', err);
    toast(err.message || 'No se pudo guardar el insumo.', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function removeItem(id) {
  if (!confirm('¿Eliminar este insumo del inventario?')) return;
  try {
    await window.db.inventory.remove(id);
    toast('Insumo eliminado.', 'success');
    await loadInventory();
  } catch (err) {
    toast(err.message || 'No se pudo eliminar el insumo.', 'error');
  }
}

// ==========================================================================
// MODAL AGREGAR STOCK
// ==========================================================================
function openStockModal(id) {
  const item = inventory.find((x) => x.id === id);
  if (!item) return;
  document.getElementById('stock-modal-item-name').textContent = item.name;
  document.getElementById('stock-item-id').value = item.id;
  document.getElementById('stock-quantity').value = '';
  document.getElementById('stock-cost').value = '';
  document.getElementById('stock-reason').value = 'Compra';
  openModal('stock-modal');
}

async function saveStock() {
  const btn = document.getElementById('btn-save-stock');
  const id = document.getElementById('stock-item-id').value;
  const quantity = document.getElementById('stock-quantity').value;
  const cost = document.getElementById('stock-cost').value;
  const reason = document.getElementById('stock-reason').value;

  if (!quantity || Number(quantity) <= 0) {
    toast('Indica una cantidad mayor a cero.', 'error');
    return;
  }

  btn.disabled = true;
  try {
    await window.db.inventory.addStock(Number(id), {
      quantity: Number(quantity),
      cost_per_unit: cost !== '' ? Number(cost) : undefined,
      reason
    });
    toast('Stock agregado.', 'success');
    closeModal('stock-modal');
    await loadInventory();
  } catch (err) {
    console.error('ERROR AL AGREGAR STOCK:', err);
    toast(err.message || 'No se pudo agregar el stock.', 'error');
  } finally {
    btn.disabled = false;
  }
}

// ==========================================================================
// MODAL HISTORIAL
// ==========================================================================
const MOVEMENT_LABELS = {
  entrada: 'Entrada',
  salida: 'Salida',
  ajuste: 'Ajuste',
  merma: 'Merma',
  venta: 'Venta'
};

async function openHistoryModal(id) {
  const item = inventory.find((x) => x.id === id);
  if (!item) return;
  document.getElementById('history-modal-item-name').textContent = item.name;
  const tbody = document.getElementById('history-tbody');
  tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Cargando...</div></td></tr>`;
  openModal('history-modal');

  try {
    const movements = await window.db.inventory.getMovements(id);
    if (!movements || movements.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Sin movimientos registrados.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = movements
      .map((m) => {
        const qty = Number(m.quantity);
        return `
        <tr>
          <td>${fmtDate(m.created_at)}</td>
          <td>${escapeHtml(MOVEMENT_LABELS[m.type] || m.type)}</td>
          <td class="${qty >= 0 ? 'movement-qty-pos' : 'movement-qty-neg'}">${qty >= 0 ? '+' : ''}${qty}</td>
          <td>${escapeHtml(m.reason || '—')}</td>
          <td>${escapeHtml(m.created_by || '—')}</td>
        </tr>
      `;
      })
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">No se pudo cargar el historial.</div></td></tr>`;
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ==========================================================================
// INIT ÚNICO — todos los listeners se registran una sola vez. Las acciones
// por fila usan delegación de eventos sobre el tbody (no se reasignan
// listeners en cada render, así que no hay fugas ni handlers duplicados).
// ==========================================================================
function init() {
  document.getElementById('btn-new-item').addEventListener('click', () => openItemModal());
  document.getElementById('btn-cancel-item').addEventListener('click', () => closeModal('item-modal'));
  document.getElementById('btn-save-item').addEventListener('click', (e) => {
    e.preventDefault();
    saveItem();
  });

  document.getElementById('btn-cancel-stock').addEventListener('click', () => closeModal('stock-modal'));
  document.getElementById('btn-save-stock').addEventListener('click', (e) => {
    e.preventDefault();
    saveStock();
  });

  document.getElementById('btn-close-history').addEventListener('click', () => closeModal('history-modal'));

  document.getElementById('inventory-tbody').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const action = btn.dataset.action;
    if (action === 'add-stock') openStockModal(id);
    else if (action === 'history') openHistoryModal(id);
    else if (action === 'edit') openItemModal(id);
    else if (action === 'remove') removeItem(id);
  });

  document.getElementById('filter-search').addEventListener('input', (e) => {
    currentFilter.search = e.target.value;
    renderTable();
  });
  document.getElementById('filter-category').addEventListener('change', (e) => {
    currentFilter.category = e.target.value;
    renderTable();
  });
  document.getElementById('filter-sort').addEventListener('change', (e) => {
    currentFilter.sort = e.target.value;
    renderTable();
  });

  loadInventory();
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardPermission('inventario', 'can_view');
  if (!session) return;
  init();
});

// Otra instalación dio de alta/editó un insumo (o un producto, que puede
// afectar el uso-en-recetas mostrado aquí) -- refresca sola (ver
// preload.js::catalogRealtimeAPI).
window.catalogRealtimeAPI?.onChanged(() => {
  loadInventory().catch((err) => console.error('No se pudo refrescar el inventario tras un cambio remoto:', err));
});

// Ctrl+N (ver common.js): "nuevo insumo" en este módulo.
window.addEventListener('app-shortcut', (e) => {
  if (e.detail === 'Ctrl+N') openItemModal();
});
