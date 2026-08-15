let inventory = [];

async function loadInventory() {
  inventory = await window.db.inventory.getAll();
  renderKpis();
  renderTable();
}

function renderKpis() {
  const totalItems = inventory.length;
  const lowStock = inventory.filter((i) => i.stock <= i.min_stock).length;
  const totalValue = inventory.reduce((sum, i) => sum + i.stock * i.cost_per_unit, 0);

  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Insumos registrados</div>
      <div class="kpi-value">${totalItems}</div>
    </div>
    <div class="kpi-card ${lowStock > 0 ? 'danger' : 'success'}">
      <div class="kpi-label">Insumos en mínimo o por debajo</div>
      <div class="kpi-value">${lowStock}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Valor total en stock</div>
      <div class="kpi-value">${fmtMoney(totalValue)}</div>
    </div>
  `;
}

function renderTable() {
  const tbody = document.getElementById('inventory-tbody');
  if (inventory.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Sin insumos registrados.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = inventory
    .map((item) => {
      const low = item.stock <= item.min_stock;
      return `
      <tr>
        <td>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td>${item.stock}</td>
        <td>${item.min_stock}</td>
        <td>${fmtMoney(item.cost_per_unit)}</td>
        <td><span class="tag ${low ? 'low' : 'ok'}">${low ? 'Stock bajo' : 'OK'}</span></td>
        <td>
          <button class="btn btn-outline btn-sm" data-edit="${item.id}">Editar</button>
          <button class="btn btn-danger btn-sm" data-remove="${item.id}">Eliminar</button>
        </td>
      </tr>
    `;
    })
    .join('');

  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openItemModal(Number(b.dataset.edit))));
  tbody.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeItem(Number(b.dataset.remove))));
}

function openItemModal(id = null) {
  const item = id ? inventory.find((x) => x.id === id) : null;
  document.getElementById('item-modal-title').textContent = item ? 'Editar insumo' : 'Nuevo insumo';
  document.getElementById('item-id').value = item ? item.id : '';
  document.getElementById('item-name').value = item ? item.name : '';
  document.getElementById('item-unit').value = item ? item.unit : '';
  document.getElementById('item-stock').value = item ? item.stock : '';
  document.getElementById('item-min-stock').value = item ? item.min_stock : '';
  document.getElementById('item-cost').value = item ? item.cost_per_unit : '';
  openModal('item-modal');
}

document.getElementById('btn-new-item').addEventListener('click', () => openItemModal());
document.getElementById('btn-cancel-item').addEventListener('click', () => closeModal('item-modal'));

document.getElementById('btn-save-item').addEventListener('click', async () => {
  const id = document.getElementById('item-id').value;
  const name = document.getElementById('item-name').value.trim();
  const unit = document.getElementById('item-unit').value.trim() || 'pza';
  const stock = document.getElementById('item-stock').value;
  const min_stock = document.getElementById('item-min-stock').value;
  const cost_per_unit = document.getElementById('item-cost').value;

  if (!name) {
    toast('El nombre es obligatorio.', 'error');
    return;
  }

  const data = { name, unit, stock: Number(stock) || 0, min_stock: Number(min_stock) || 0, cost_per_unit: Number(cost_per_unit) || 0 };

  try {
    if (id) {
      await window.db.inventory.update(Number(id), data);
      toast('Insumo actualizado.', 'success');
    } else {
      await window.db.inventory.create(data);
      toast('Insumo creado.', 'success');
    }
    closeModal('item-modal');
    loadInventory();
  } catch (err) {
    toast('No se pudo guardar el insumo.', 'error');
  }
});

async function removeItem(id) {
  if (!confirm('¿Eliminar este insumo del inventario?')) return;
  try {
    await window.db.inventory.remove(id);
    toast('Insumo eliminado.', 'success');
    loadInventory();
  } catch (err) {
    toast('No se pudo eliminar el insumo.', 'error');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
  guardSession(['admin']);
  loadInventory();
});
