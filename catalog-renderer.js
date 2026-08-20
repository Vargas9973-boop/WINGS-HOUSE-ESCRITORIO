const CATEGORY_LABELS = {
  Alitas: 'Alitas',
  Boneless: 'Boneless',
  hotdogs: 'Hot-Dogs',
  hamburguesas: 'Hamburguesas',
  papas: 'Papas',
  acompanantes: 'Acompañantes',
  bebidas: 'Bebidas',
  extras: 'Extras',
  combos: 'Combos/Promos'
};

// Etiqueta legible de cualquier categoría, incluida "Todas las categorías" (null).
function categoryLabel(category) {
  if (!category) return 'Todas las categorías';
  return CATEGORY_LABELS[category] || category;
}

const NAME_PLACEHOLDERS = {
  Alitas: 'Ej. Alitas 10 pzs',
  Boneless: 'Ej. Boneless 10 pzs'
};
const DEFAULT_NAME_PLACEHOLDER = 'Ej. Papas Gajo';

let products = [];
let promotions = [];
let inventoryOptions = [];
let productIdsWithRecipe = new Set();
let recipeCostsByProduct = {};
let productAvailability = {};
let originalRecipeInsumoIds = new Set(); // receta cargada al abrir el modal de edición, para avisar si se quita un insumo
let onlyMissingRecipe = false;
let modifiers = [];
let productModifierGroups = []; // filas {product_id, group_name, qty}
let productComponents = []; // filas {parent_product_id, component_product_id, qty, component}
let productIdsWithComponents = new Set();

async function loadRecipeSupportData() {
  try {
    const [inv, ids, costs, recipesRaw] = await Promise.all([
      window.db.inventory.getAll(),
      window.db.recipes.getProductIdsWithRecipe(),
      window.db.recipes.getAllCosts(),
      window.db.recipes.getAllWithStock()
    ]);
    inventoryOptions = inv;
    productIdsWithRecipe = new Set(ids);
    recipeCostsByProduct = costs;
    productAvailability = computeProductAvailability(recipesRaw);
  } catch (err) {
    console.error('No se pudo cargar el soporte de recetas:', err);
  }
}

// ---------------- MODIFICADORES (salsas) ----------------
async function loadModifiersData() {
  try {
    const [mods, pmg] = await Promise.all([
      window.db.modifiers.list(), // sin groupName: trae todos
      window.db.productModifierGroups.getAll()
    ]);
    modifiers = mods;
    productModifierGroups = pmg;
  } catch (err) {
    console.error('No se pudieron cargar los modificadores:', err);
  }
}

function productHasSaucesGroup(productId) {
  return productModifierGroups.some((r) => r.product_id === productId && r.group_name === 'Salsas');
}

function saucesGroupQty(productId) {
  const row = productModifierGroups.find((r) => r.product_id === productId && r.group_name === 'Salsas');
  return row ? Math.max(1, Number(row.qty) || 1) : 1;
}

// ---------------- COMBOS (product_components) ----------------
async function loadComboData() {
  try {
    productComponents = await window.db.productComponents.getAll();
    productIdsWithComponents = new Set(productComponents.map((r) => r.parent_product_id));
  } catch (err) {
    console.error('No se pudieron cargar los combos:', err);
  }
}

function renderModifiers() {
  const tbody = document.getElementById('modifiers-tbody');
  if (!tbody) return;

  if (modifiers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">No hay modificadores registrados.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = modifiers
    .map(
      (m) => `
    <tr>
      <td>${escapeHtml(m.name)}</td>
      <td>${escapeHtml(m.group_name)}</td>
      <td>
        <select class="modifier-inventory-select" data-id="${m.id}">
          <option value="">Sin vincular</option>
          ${inventoryOptions
            .map(
              (i) =>
                `<option value="${i.id}" ${i.id === m.inventory_id ? 'selected' : ''}>${escapeHtml(i.name)} (${i.stock} ${escapeHtml(i.unit || '')})</option>`
            )
            .join('')}
        </select>
      </td>
      <td>
        <button class="btn btn-outline btn-sm" data-save-modifier="${m.id}">Guardar</button>
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-save-modifier]').forEach((b) => {
    b.addEventListener('click', () => saveModifierInventory(Number(b.dataset.saveModifier)));
  });
}

async function saveModifierInventory(id) {
  const select = document.querySelector(`.modifier-inventory-select[data-id="${id}"]`);
  const inventoryId = select.value ? Number(select.value) : null;
  try {
    await window.db.modifiers.update(id, { inventory_id: inventoryId });
    toast('Modificador actualizado.', 'success');
    await loadModifiersData();
    renderModifiers();
  } catch (err) {
    console.error('No se pudo actualizar el modificador:', err);
    toast('No se pudo actualizar el modificador.', 'error');
  }
}

const AVAILABILITY_BADGE = {
  rojo: { cls: 'low', label: '🔴 Sin stock' },
  amarillo: { cls: 'warning', label: '🟡 Stock bajo' },
  verde: { cls: 'active', label: '🟢 Disponible' }
};

// Una línea por insumo de la receta, en la unidad propia de ese insumo
// (nunca se convierte -- quantity_needed siempre está en esa unidad):
// "Stock: 100 pz, necesita 6 pz por unidad -> alcanza para 16 ventas".
function availabilityDetailLines(avail) {
  return (avail.insumos || []).map((row) => {
    const unit = row.unit || '';
    const cap = row.needed > 0 ? Math.floor(row.stock / row.needed) : '∞';
    return `Stock: ${row.stock} ${unit}, necesita ${row.needed} ${unit} por unidad → alcanza para ${cap} venta${cap === 1 ? '' : 's'}`;
  });
}

function availabilityBadge(productId) {
  const avail = productAvailability[productId];
  if (!avail) return `<span class="tag warning" title="Este producto no tiene insumos asignados todavía.">Sin receta</span>`;
  const info = AVAILABILITY_BADGE[avail.status];
  const lines = availabilityDetailLines(avail);
  const label = avail.status === 'rojo'
    ? info.label
    : `${info.label} (${avail.maxSellable != null ? avail.maxSellable : '∞'})`;
  return `<span class="tag ${info.cls}" title="${escapeHtml(lines.join('\n'))}">${label}</span>`;
}

// Compatibilidad: normaliza valores legacy de categoría a los definitivos
// 'Alitas' / 'Boneless'. Cubre el literal "Alitas y Boneless" y las claves
// antiguas en minúsculas que usó una versión previa de esta app, por si un
// registro no alcanzó a pasar por la migración de arranque (db.js ->
// migrateAlitasBonelessCategories()).
function normalizeCategory(category) {
  if (category === 'Alitas y Boneless' || category === 'alitas') return 'Alitas';
  if (category === 'boneless') return 'Boneless';
  return category;
}

// ---------------- TABS ----------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => (p.style.display = 'none'));
    document.getElementById(`tab-${btn.dataset.tab}`).style.display = 'block';
  });
});

// ---------------- PRODUCTOS ----------------
async function loadProducts() {
  products = await window.db.products.getAll();
  renderProducts();
}

function renderProducts() {
  const tbody = document.getElementById('products-tbody');
  const visible = onlyMissingRecipe ? products.filter((p) => !productIdsWithRecipe.has(p.id)) : products;

  if (visible.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">${onlyMissingRecipe ? 'Todos los productos ya tienen receta asignada.' : 'Sin productos registrados.'}</div></td></tr>`;
    return;
  }
  tbody.innerHTML = visible
    .map(
      (p) => `
    <tr>
      <td>${escapeHtml(p.name)}${productIdsWithComponents.has(p.id) ? ' <span class="tag active" title="Este producto tiene componentes de combo">COMBO</span>' : ''}</td>
      <td>${CATEGORY_LABELS[normalizeCategory(p.category)] || p.category}</td>
      <td>${fmtMoney(p.price)}${recipeCostsByProduct[p.id] != null ? `<div class="recipe-cost-hint">Costo receta: ${fmtMoney(recipeCostsByProduct[p.id])}</div>` : ''}</td>
      <td>${p.employee_price != null ? fmtMoney(p.employee_price) : '<span style="color:var(--text-muted)">Automático</span>'}</td>
      <td>${p.stock != null ? `<span class="tag ${p.stock <= 0 ? 'inactive' : 'active'}">${p.stock}</span>` : '<span style="color:var(--text-muted)">Ilimitado</span>'}</td>
      <td>${availabilityBadge(p.id)}</td>
      <td><span class="tag ${p.active ? 'active' : 'inactive'}">${p.active ? 'Activo' : 'Inactivo'}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" data-edit="${p.id}">Editar</button>
        ${productIdsWithRecipe.has(p.id) ? '' : `<button class="btn btn-outline btn-sm" data-migrate="${p.id}">Migrar receta</button>`}
        <button class="btn btn-danger btn-sm" data-remove="${p.id}">Eliminar</button>
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openProductModal(Number(b.dataset.edit))));
  tbody.querySelectorAll('[data-migrate]').forEach((b) => b.addEventListener('click', () => openProductModal(Number(b.dataset.migrate))));
  tbody.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeProduct(Number(b.dataset.remove))));
}

function updateNamePlaceholder() {
  const category = document.getElementById('product-category').value;
  document.getElementById('product-name').placeholder = NAME_PLACEHOLDERS[category] || DEFAULT_NAME_PLACEHOLDER;
}

// ---------------- RECETA (insumos por producto) ----------------
// La cantidad de la receta siempre se guarda en la unidad propia del insumo
// (pz, kg, g, mg, L, ml...) -- nunca se convierte -- así que aquí solo se
// refleja esa unidad junto al campo de cantidad (badge + "= 6 pz" en vivo),
// no se deja elegir una unidad distinta.
function addRecipeRow(insumoId = '', quantity = '') {
  const container = document.getElementById('recipe-rows');
  const row = document.createElement('div');
  row.className = 'field-row recipe-row';
  row.innerHTML = `
    <select class="recipe-insumo">
      <option value="">Selecciona un insumo...</option>
      ${inventoryOptions
        .map((i) => `<option value="${i.id}">${escapeHtml(i.name)} (${escapeHtml(i.unit || '')})</option>`)
        .join('')}
    </select>
    <span class="recipe-unit-badge" title="Unidad del insumo en inventario">—</span>
    <input type="number" class="recipe-qty" min="0.01" step="0.01" placeholder="Cantidad">
    <span class="recipe-qty-preview"></span>
    <button type="button" class="btn btn-danger btn-sm" data-remove-recipe-row>✕</button>
  `;
  const selectEl = row.querySelector('.recipe-insumo');
  const badgeEl = row.querySelector('.recipe-unit-badge');
  const qtyEl = row.querySelector('.recipe-qty');
  const previewEl = row.querySelector('.recipe-qty-preview');

  function currentUnit() {
    const insumo = inventoryOptions.find((i) => i.id === Number(selectEl.value));
    return insumo ? insumo.unit || '' : '';
  }
  function updatePreview() {
    const unit = currentUnit();
    previewEl.textContent = qtyEl.value && unit ? `= ${qtyEl.value} ${unit}` : '';
  }
  function updateUnitUI() {
    const unit = currentUnit();
    badgeEl.textContent = unit || '—';
    badgeEl.classList.toggle('is-empty', !unit);
    qtyEl.placeholder = unit ? `Cantidad en ${unit}` : 'Cantidad';
    updatePreview();
  }

  selectEl.value = insumoId ? String(insumoId) : '';
  qtyEl.value = quantity || '';
  selectEl.addEventListener('change', updateUnitUI);
  qtyEl.addEventListener('input', updatePreview);
  row.querySelector('[data-remove-recipe-row]').addEventListener('click', () => row.remove());
  container.appendChild(row);
  updateUnitUI();
}

function renderRecipeRows(rows) {
  const container = document.getElementById('recipe-rows');
  container.innerHTML = '';
  if (!rows || rows.length === 0) return;
  rows.forEach((r) => addRecipeRow(r.insumo_id, r.quantity_needed));
}

function collectRecipeRows() {
  return Array.from(document.querySelectorAll('#recipe-rows .recipe-row'))
    .map((row) => ({
      insumo_id: Number(row.querySelector('.recipe-insumo').value) || null,
      quantity_needed: Number(row.querySelector('.recipe-qty').value) || 0
    }))
    .filter((r) => r.insumo_id && r.quantity_needed > 0);
}

document.getElementById('btn-add-recipe-row').addEventListener('click', () => addRecipeRow());

// ---------------- COMBO ROWS (product_components) ----------------
// Mismo patrón que addRecipeRow/renderRecipeRows/collectRecipeRows, pero
// eligiendo un producto del catálogo (no un insumo) -- excluye al propio
// producto que se está editando para no permitir un combo autorreferente.
function addComboRow(componentProductId = '', qty = '') {
  const container = document.getElementById('combo-rows');
  const currentId = Number(document.getElementById('product-id').value) || null;
  const row = document.createElement('div');
  row.className = 'field-row combo-row';
  row.innerHTML = `
    <select class="combo-component">
      <option value="">Selecciona un producto...</option>
      ${products
        .filter((p) => p.id !== currentId)
        .map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
        .join('')}
    </select>
    <input type="number" class="combo-qty" min="0.01" step="1" placeholder="Cantidad">
    <button type="button" class="btn btn-danger btn-sm" data-remove-combo-row>✕</button>
  `;
  row.querySelector('.combo-component').value = componentProductId ? String(componentProductId) : '';
  row.querySelector('.combo-qty').value = qty || '';
  row.querySelector('[data-remove-combo-row]').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function renderComboRows(rows) {
  const container = document.getElementById('combo-rows');
  container.innerHTML = '';
  if (!rows || rows.length === 0) return;
  rows.forEach((r) => addComboRow(r.component_product_id, r.qty));
}

function collectComboRows() {
  return Array.from(document.querySelectorAll('#combo-rows .combo-row'))
    .map((row) => ({
      component_product_id: Number(row.querySelector('.combo-component').value) || null,
      qty: Number(row.querySelector('.combo-qty').value) || 0
    }))
    .filter((r) => r.component_product_id && r.qty > 0);
}

document.getElementById('btn-add-combo-row').addEventListener('click', () => addComboRow());

document.getElementById('product-sauces-group').addEventListener('change', (e) => {
  document.getElementById('product-sauces-qty-wrap').style.display = e.target.checked ? 'flex' : 'none';
});

async function openProductModal(id = null) {
  const p = id ? products.find((x) => x.id === id) : null;
  document.getElementById('product-modal-title').textContent = p ? 'Editar producto' : 'Nuevo producto';
  document.getElementById('product-id').value = p ? p.id : '';
  document.getElementById('product-name').value = p ? p.name : '';
  document.getElementById('product-category').value = p ? normalizeCategory(p.category) : 'Alitas';
  document.getElementById('product-price').value = p ? p.price : '';
  document.getElementById('product-employee-price').value = p && p.employee_price != null ? p.employee_price : '';
  document.getElementById('product-active').value = p ? String(p.active) : '1';
  document.getElementById('product-stock').value = p && p.stock != null ? p.stock : '';
  const hasSauces = p ? productHasSaucesGroup(p.id) : false;
  document.getElementById('product-sauces-group').checked = hasSauces;
  document.getElementById('product-sauces-qty').value = p ? saucesGroupQty(p.id) : 1;
  document.getElementById('product-sauces-qty-wrap').style.display = hasSauces ? 'flex' : 'none';
  updateNamePlaceholder();
  document.getElementById('recipe-rows').innerHTML = '';
  document.getElementById('combo-rows').innerHTML = '';
  originalRecipeInsumoIds = new Set();
  openModal('product-modal');

  if (p) {
    try {
      const recipeRows = await window.db.recipes.getForProduct(p.id);
      renderRecipeRows(recipeRows);
      originalRecipeInsumoIds = new Set((recipeRows || []).map((r) => Number(r.insumo_id)));
    } catch (err) {
      console.error('No se pudo cargar la receta del producto:', err);
    }

    try {
      const comboRows = await window.db.productComponents.getForProduct(p.id);
      renderComboRows(comboRows);
    } catch (err) {
      console.error('No se pudieron cargar los componentes del combo:', err);
    }
  }
}

document.getElementById('btn-new-product').addEventListener('click', () => openProductModal());
document.getElementById('btn-cancel-product').addEventListener('click', () => closeModal('product-modal'));
document.getElementById('product-category').addEventListener('change', updateNamePlaceholder);

document.getElementById('btn-save-product').addEventListener('click', async () => {
  const id = document.getElementById('product-id').value;
  const name = document.getElementById('product-name').value.trim();
  const category = document.getElementById('product-category').value;
  const price = document.getElementById('product-price').value;
  const employeePriceRaw = document.getElementById('product-employee-price').value;
  const active = document.getElementById('product-active').value === '1';
  const stockRaw = document.getElementById('product-stock').value;

  if (!name || !price) {
    toast('Nombre y precio son obligatorios.', 'error');
    return;
  }

  const data = {
    name,
    category,
    price: Number(price),
    employee_price: employeePriceRaw ? Number(employeePriceRaw) : null,
    active,
    stock: stockRaw !== '' ? Number(stockRaw) : null
  };

  const recipeRows = collectRecipeRows();
  const comboRows = collectComboRows();
  const saucesEnabled = document.getElementById('product-sauces-group').checked;
  const saucesQty = Math.max(1, Number(document.getElementById('product-sauces-qty').value) || 1);

  // No se puede dar de alta (ni dejar) un producto sin insumos asignados,
  // salvo que sea un combo: ahí el insumo directo es opcional (puede vivir
  // solo en sus componentes -- p.ej. un combo hecho 100% de otros
  // productos del catálogo).
  if (recipeRows.length === 0 && comboRows.length === 0) {
    toast('Debes asignar insumos del inventario a la receta de este producto, o al menos un componente de combo.', 'error');
    return;
  }

  // Ninguno de los insumos elegidos puede tener menos stock del que la
  // receta necesita para 1 venta -- si falta stock, se bloquea el guardado
  // y se le dice al usuario exactamente cuál insumo abastecer.
  for (const row of recipeRows) {
    const insumo = inventoryOptions.find((i) => i.id === row.insumo_id);
    if (!insumo) {
      toast('Uno de los insumos seleccionados ya no existe en inventario.', 'error');
      return;
    }
    const stock = Number(insumo.stock) || 0;
    if (stock <= 0 || stock < row.quantity_needed) {
      toast(`Sin stock en inventario: ${insumo.name} (${stock}${insumo.unit ? ' ' + insumo.unit : ''}). Abastece inventario primero.`, 'error');
      return;
    }
  }

  // Al editar, si se quitó un insumo que ya estaba en la receta, se pide
  // confirmación explícita antes de guardar (puede afectar recetas/costos
  // que dependían de él).
  if (id) {
    const newIds = new Set(recipeRows.map((r) => r.insumo_id));
    const removed = [...originalRecipeInsumoIds].filter((iid) => !newIds.has(iid));
    if (removed.length > 0) {
      const removedNames = removed
        .map((iid) => (inventoryOptions.find((i) => i.id === iid) || {}).name || `#${iid}`)
        .join(', ');
      if (!confirm(`Vas a quitar de la receta: ${removedNames}. ¿Confirmas guardar los cambios?`)) {
        return;
      }
    }
  }

  const btn = document.getElementById('btn-save-product');
  btn.disabled = true;
  try {
    let productId = id ? Number(id) : null;
    if (productId) {
      await window.db.products.update(productId, data);
      toast('Producto actualizado.', 'success');
    } else {
      const created = await window.db.products.create(data);
      productId = created.id;
      toast('Producto creado.', 'success');
    }

    try {
      await window.db.recipes.setForProduct(productId, recipeRows);
    } catch (recipeErr) {
      console.error('No se pudo guardar la receta:', recipeErr);
      toast('El producto se guardó, pero no se pudo guardar su receta.', 'error');
    }

    try {
      await window.db.productModifierGroups.set(productId, 'Salsas', saucesEnabled, saucesQty);
    } catch (modErr) {
      console.error('No se pudo actualizar el grupo de modificadores:', modErr);
      toast('El producto se guardó, pero no se pudo actualizar la selección de salsa.', 'error');
    }

    try {
      await window.db.productComponents.setForProduct(productId, comboRows);
    } catch (comboErr) {
      console.error('No se pudieron guardar los componentes del combo:', comboErr);
      toast('El producto se guardó, pero no se pudieron guardar los componentes del combo.', 'error');
    }

    closeModal('product-modal');
    await loadProducts();
    await loadRecipeSupportData();
    await loadModifiersData();
    await loadComboData();
    renderProducts();
    renderModifiers();
  } catch (err) {
  console.error('ERROR AL GUARDAR PRODUCTO:', err);
  toast(`No se pudo guardar el producto: ${err.message}`, 'error');
} finally {
  btn.disabled = false;
}
});

async function removeProduct(id) {
  if (!confirm('¿Eliminar este producto del catálogo?')) return;
  try {
    const res = await window.db.products.remove(id);
    toast(res.deactivated ? 'Producto con historial de ventas: se marcó como inactivo.' : 'Producto eliminado.', 'success');
    loadProducts();
  } catch (err) {
    toast('No se pudo eliminar el producto.', 'error');
  }
}

// ---------------- PROMOCIONES ----------------
async function loadPromotions() {
  promotions = await window.db.promotions.getAll();
  renderPromotions();
}

function renderPromotions() {
  const tbody = document.getElementById('promos-tbody');
  if (promotions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Aún no hay promociones. Crea la primera para que aparezca en Ventas.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = promotions
    .map(
      (p) => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.description || '—')}</td>
      <td>${fmtMoney(p.price)}</td>
      <td>${escapeHtml(categoryLabel(p.applicable_category))}</td>
      <td><span class="tag ${p.active ? 'active' : 'inactive'}">${p.active ? 'Activa' : 'Inactiva'}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" data-edit="${p.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-remove="${p.id}">Eliminar</button>
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openPromoModal(Number(b.dataset.edit))));
  tbody.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removePromo(Number(b.dataset.remove))));
}

function openPromoModal(id = null) {
  const p = id ? promotions.find((x) => x.id === id) : null;
  document.getElementById('promo-modal-title').textContent = p ? 'Editar promoción' : 'Nueva promoción';
  document.getElementById('promo-id').value = p ? p.id : '';
  document.getElementById('promo-name').value = p ? p.name : '';
  document.getElementById('promo-description').value = p ? p.description || '' : '';
  document.getElementById('promo-price').value = p ? p.price : '';
  document.getElementById('promo-active').value = p ? String(p.active) : '1';
  document.getElementById('promo-category').value = p && p.applicable_category ? p.applicable_category : '';
  openModal('promo-modal');
}

document.getElementById('btn-new-promo').addEventListener('click', () => openPromoModal());
document.getElementById('btn-cancel-promo').addEventListener('click', () => closeModal('promo-modal'));

document.getElementById('btn-save-promo').addEventListener('click', async () => {
  const id = document.getElementById('promo-id').value;
  const name = document.getElementById('promo-name').value.trim();
  const description = document.getElementById('promo-description').value.trim();
  const price = document.getElementById('promo-price').value;
  const active = document.getElementById('promo-active').value === '1';
  const applicableCategory = document.getElementById('promo-category').value || null;

  if (!name || !price) {
    toast('Nombre y precio son obligatorios.', 'error');
    return;
  }

  const data = { name, description, price: Number(price), active, applicable_category: applicableCategory };

  try {
    if (id) {
      await window.db.promotions.update(Number(id), data);
      toast('Promoción actualizada.', 'success');
    } else {
      await window.db.promotions.create(data);
      toast('Promoción creada.', 'success');
    }
    closeModal('promo-modal');
    loadPromotions();
  } catch (err) {
    toast('No se pudo guardar la promoción.', 'error');
  }
});

async function removePromo(id) {
  if (!confirm('¿Eliminar esta promoción?')) return;
  try {
    const res = await window.db.promotions.remove(id);
    toast(res.deactivated ? 'Promoción con historial de ventas: se marcó como inactiva.' : 'Promoción eliminada.', 'success');
    loadPromotions();
  } catch (err) {
    toast('No se pudo eliminar la promoción.', 'error');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.getElementById('chk-only-missing-recipe').addEventListener('change', (e) => {
  onlyMissingRecipe = e.target.checked;
  renderProducts();
});

document.addEventListener('DOMContentLoaded', async () => {
  guardSession(['admin']);
  await loadRecipeSupportData();
  await loadModifiersData();
  await loadComboData();
  await loadProducts();
  loadPromotions();
  renderModifiers();
});
