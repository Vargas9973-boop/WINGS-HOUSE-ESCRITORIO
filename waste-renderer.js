let wasteRecords = [];
let inventoryOptions = [];

const TIPO_LABELS = { merma: 'Merma', consumo_interno: 'Consumo Jefes' };

async function loadWaste() {
  wasteRecords = await window.db.waste.getAll();
  renderKpis();
  renderTable();
}

function isThisMonth(dateStr) {
  const d = new Date(dateStr.replace(' ', 'T'));
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function renderKpis() {
  const totalCost = wasteRecords.reduce((sum, w) => sum + w.cost, 0);
  const todayCost = wasteRecords
    .filter((w) => isToday(w.created_at))
    .reduce((sum, w) => sum + w.cost, 0);
  const consumoInternoMes = wasteRecords
    .filter((w) => w.tipo === 'consumo_interno' && isThisMonth(w.created_at))
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
    <div class="kpi-card warning">
      <div class="kpi-label">Consumo interno del mes</div>
      <div class="kpi-value">${fmtMoney(consumoInternoMes)}</div>
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
  const tipoFiltro = document.getElementById('filter-tipo').value;
  const rows = tipoFiltro ? wasteRecords.filter((w) => w.tipo === tipoFiltro) : wasteRecords;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Sin registros de merma.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (w) => `
    <tr>
      <td>${fmtDate(w.created_at)}</td>
      <td>${escapeHtml(w.item_name)}</td>
      <td>${w.quantity} ${escapeHtml(w.unit)}</td>
      <td>${TIPO_LABELS[w.tipo] || 'Merma'}</td>
      <td>${escapeHtml(w.reason)}</td>
      <td>${fmtMoney(w.cost)}</td>
    </tr>
  `
    )
    .join('');
}

document.getElementById('filter-tipo').addEventListener('change', renderTable);

async function openWasteModal() {
  inventoryOptions = await window.db.inventory.getAll();
  const select = document.getElementById('waste-inventory');
  select.innerHTML = inventoryOptions
    .map((i) => `<option value="${i.id}">${escapeHtml(i.name)} (existencia: ${i.stock} ${escapeHtml(i.unit)})</option>`)
    .join('');
  document.getElementById('waste-quantity').value = '';
  document.getElementById('waste-cost').value = '';
  document.getElementById('tipo').value = 'merma';
  document.getElementById('autorizado_por').value = '';
  document.getElementById('autorizado-por-field').style.display = 'none';
  openModal('waste-modal');
}

document.getElementById('btn-new-waste').addEventListener('click', openWasteModal);
document.getElementById('btn-cancel-waste').addEventListener('click', () => closeModal('waste-modal'));

document.getElementById('tipo').addEventListener('change', (e) => {
  document.getElementById('autorizado-por-field').style.display = e.target.value === 'consumo_interno' ? 'block' : 'none';
});

document.getElementById('btn-save-waste').addEventListener('click', async () => {
  const inventoryId = Number(document.getElementById('waste-inventory').value);
  const quantity = Number(document.getElementById('waste-quantity').value);
  const costRaw = document.getElementById('waste-cost').value;
  const reason = document.getElementById('waste-reason').value;
  const tipo = document.getElementById('tipo').value;
  const autorizadoPor = document.getElementById('autorizado_por').value.trim();

  if (!inventoryId || !quantity) {
    toast('Selecciona un insumo y una cantidad válida.', 'error');
    return;
  }
  if (tipo === 'consumo_interno' && !autorizadoPor) {
    toast('Indica qué jefe autoriza el consumo interno.', 'error');
    return;
  }

  try {
    await window.db.waste.create({
      inventory_id: inventoryId,
      quantity,
      cost: costRaw ? Number(costRaw) : null,
      reason,
      tipo,
      autorizado_por: tipo === 'consumo_interno' ? autorizadoPor : null
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
