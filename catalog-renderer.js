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
  if (products.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Sin productos registrados.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = products
    .map(
      (p) => `
    <tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${CATEGORY_LABELS[normalizeCategory(p.category)] || p.category}</td>
      <td>${fmtMoney(p.price)}</td>
      <td>${p.employee_price != null ? fmtMoney(p.employee_price) : '<span style="color:var(--text-muted)">Automático</span>'}</td>
      <td>${p.stock != null ? `<span class="tag ${p.stock <= 0 ? 'inactive' : 'active'}">${p.stock}</span>` : '<span style="color:var(--text-muted)">Ilimitado</span>'}</td>
      <td><span class="tag ${p.active ? 'active' : 'inactive'}">${p.active ? 'Activo' : 'Inactivo'}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" data-edit="${p.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-remove="${p.id}">Eliminar</button>
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openProductModal(Number(b.dataset.edit))));
  tbody.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeProduct(Number(b.dataset.remove))));
}

function updateNamePlaceholder() {
  const category = document.getElementById('product-category').value;
  document.getElementById('product-name').placeholder = NAME_PLACEHOLDERS[category] || DEFAULT_NAME_PLACEHOLDER;
}

function openProductModal(id = null) {
  const p = id ? products.find((x) => x.id === id) : null;
  document.getElementById('product-modal-title').textContent = p ? 'Editar producto' : 'Nuevo producto';
  document.getElementById('product-id').value = p ? p.id : '';
  document.getElementById('product-name').value = p ? p.name : '';
  document.getElementById('product-category').value = p ? normalizeCategory(p.category) : 'Alitas';
  document.getElementById('product-price').value = p ? p.price : '';
  document.getElementById('product-employee-price').value = p && p.employee_price != null ? p.employee_price : '';
  document.getElementById('product-active').value = p ? String(p.active) : '1';
  document.getElementById('product-stock').value = p && p.stock != null ? p.stock : '';
  updateNamePlaceholder();
  openModal('product-modal');
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

  try {
    if (id) {
      await window.db.products.update(Number(id), data);
      toast('Producto actualizado.', 'success');
    } else {
      await window.db.products.create(data);
      toast('Producto creado.', 'success');
    }
    closeModal('product-modal');
    loadProducts();
  } catch (err) {
  console.error('ERROR AL GUARDAR PRODUCTO:', err);
  toast(`No se pudo guardar el producto: ${err.message}`, 'error');
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

document.addEventListener('DOMContentLoaded', () => {
  guardSession(['admin']);
  loadProducts();
  loadPromotions();
});
