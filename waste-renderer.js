let wasteRecords = [];
let inventoryOptions = [];

async function loadWaste() {
  wasteRecords = await window.db.waste.getAll();
  renderKpis();
  renderTable();
}

function renderKpis() {
  const totalCost = wasteRecords.reduce((sum, w) => sum + w.cost, 0);
  const todayCost = wasteRecords
    .filter((w) => isToday(w.created_at))
    .reduce((sum, w) => sum + w.cost, 0);

  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi-card danger">
      <div class="kpi-label">Costo total en merma</div>
      <div class="kpi-value">${fmtMoney(totalCost)}</div>
    </div>
    <div class="kpi-card danger">
      <div class="kpi-label">Merma de hoy</div>
      <div class="kpi-value">${fmtMoney(todayCost)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Registros totales</div>
      <div class="kpi-value">${wasteRecords.length}</div>
    </div>
  `;
}

function isToday(dateStr) {
  const d = new Date(dateStr.replace(' ', 'T'));
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function renderTable() {
  const tbody = document.getElementById('waste-tbody');
  if (wasteRecords.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Sin registros de merma.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = wasteRecords
    .map(
      (w) => `
    <tr>
      <td>${fmtDate(w.created_at)}</td>
      <td>${escapeHtml(w.item_name)}</td>
      <td>${w.quantity} ${escapeHtml(w.unit)}</td>
      <td>${escapeHtml(w.reason)}</td>
      <td>${fmtMoney(w.cost)}</td>
    </tr>
  `
    )
    .join('');
}

async function openWasteModal() {
  inventoryOptions = await window.db.inventory.getAll();
  const select = document.getElementById('waste-inventory');
  select.innerHTML = inventoryOptions
    .map((i) => `<option value="${i.id}">${escapeHtml(i.name)} (existencia: ${i.stock} ${escapeHtml(i.unit)})</option>`)
    .join('');
  document.getElementById('waste-quantity').value = '';
  document.getElementById('waste-cost').value = '';
  openModal('waste-modal');
}

document.getElementById('btn-new-waste').addEventListener('click', openWasteModal);
document.getElementById('btn-cancel-waste').addEventListener('click', () => closeModal('waste-modal'));

document.getElementById('btn-save-waste').addEventListener('click', async () => {
  const inventoryId = Number(document.getElementById('waste-inventory').value);
  const quantity = Number(document.getElementById('waste-quantity').value);
  const costRaw = document.getElementById('waste-cost').value;
  const reason = document.getElementById('waste-reason').value;

  if (!inventoryId || !quantity) {
    toast('Selecciona un insumo y una cantidad válida.', 'error');
    return;
  }

  try {
    await window.db.waste.create({
      inventory_id: inventoryId,
      quantity,
      cost: costRaw ? Number(costRaw) : null,
      reason
    });
    toast('Merma registrada y stock actualizado.', 'success');
    closeModal('waste-modal');
    loadWaste();
  } catch (err) {
    toast('No se pudo registrar la merma.', 'error');
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
  guardSession(['admin']);
  loadWaste();
});
