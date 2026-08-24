let wasteRecords = [];
let benefitRecords = [];
let inventoryOptions = [];

const TIPO_LABELS = {
  merma: 'Merma',
  consumo_interno: 'Consumo Jefes',
  beneficio_empleado: 'Consumo Beneficio Empleado'
};

async function loadWaste() {
  const [waste, benefit] = await Promise.all([
    window.db.waste.getAll(),
    // Solo lectura, derivado de las ventas con beneficio de empleado -- no
    // vive en la tabla waste, ver 20260823240000_employee_benefit_waste_visibility.sql.
    window.db.waste.getEmployeeBenefitConsumption()
  ]);
  wasteRecords = waste;
  benefitRecords = benefit;
  renderKpis();
  renderTable();
}

// consumption_date llega como fecha pura 'YYYY-MM-DD' (sin hora/offset,
// ya calculada en hora de México del lado del servidor) -- new Date() la
// interpreta como medianoche UTC, y comparar con getters locales la corre
// un día en cualquier zona detrás de UTC (mismo bug de fondo que ya se
// arregló en getUnifiedHistory/getCorteResumen). Se normaliza a mediodía
// antes de parsear para que quede en el mismo día calendario sin importar
// el offset local.
function toLocalDate(dateStr) {
  const normalized = dateStr.length === 10 ? `${dateStr}T12:00:00` : dateStr.replace(' ', 'T');
  return new Date(normalized);
}

function isThisMonth(dateStr) {
  const d = toLocalDate(dateStr);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function renderKpis() {
  const allRows = [...wasteRecords, ...benefitRecords];
  const totalCost = allRows.reduce((sum, w) => sum + w.cost, 0);
  const todayCost = allRows
    .filter((w) => isToday(w.created_at))
    .reduce((sum, w) => sum + w.cost, 0);
  const consumoInternoMes = wasteRecords
    .filter((w) => w.tipo === 'consumo_interno' && isThisMonth(w.created_at))
    .reduce((sum, w) => sum + w.cost, 0);
  const beneficioMes = benefitRecords
    .filter((w) => isThisMonth(w.created_at))
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
    <div class="kpi-card warning">
      <div class="kpi-label">Consumo beneficio empleado del mes</div>
      <div class="kpi-value">${fmtMoney(beneficioMes)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Registros totales</div>
      <div class="kpi-value">${wasteRecords.length + benefitRecords.length}</div>
    </div>
  `;
}

function isToday(dateStr) {
  const d = toLocalDate(dateStr);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function renderTable() {
  const tbody = document.getElementById('waste-tbody');
  const tipoFiltro = document.getElementById('filter-tipo').value;
  const allRows = [...wasteRecords, ...benefitRecords].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const rows = tipoFiltro ? allRows.filter((w) => w.tipo === tipoFiltro) : allRows;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Sin registros de merma.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (w) => `
    <tr${w.tipo === 'beneficio_empleado' ? ' title="Generado automáticamente por la venta -- no editable desde aquí"' : ''}>
      <td>${fmtDate(w.created_at)}</td>
      <td>${escapeHtml(w.item_name)}</td>
      <td>${w.quantity} ${escapeHtml(w.unit)}</td>
      <td>${TIPO_LABELS[w.tipo] || 'Merma'}</td>
      <td>${escapeHtml(w.reason)}</td>
      <td>${fmtMoney(w.cost)}${w.costIsEstimated ? ' <span title="Costo estimado: no se pudo resolver el costo de receta del producto">≈</span>' : ''}</td>
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
  guardPermission('inventario', 'can_view');
  loadWaste();
});
