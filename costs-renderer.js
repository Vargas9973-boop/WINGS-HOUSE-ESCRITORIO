let currentCosts = [];

function todayISO() {
  return localISODate();
}

function firstOfMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

async function loadReport() {
  const dateFrom = document.getElementById('filter-from').value;
  const dateTo = document.getElementById('filter-to').value;

  const [report, costs] = await Promise.all([
    window.db.reports.profitability({ dateFrom, dateTo }),
    window.db.costs.getAll({ dateFrom, dateTo })
  ]);

  currentCosts = costs;
  renderKpis(report);
  renderChart(report.byDay);
  renderTopProducts(report.topProducts);
  renderCosts();
}

function renderKpis(report) {
  document.getElementById('kpi-grid').innerHTML = `
    <div class="kpi-card success">
      <div class="kpi-label">Ventas totales</div>
      <div class="kpi-value">${fmtMoney(report.totalSales)}</div>
    </div>
    <div class="kpi-card danger">
      <div class="kpi-label">Merma</div>
      <div class="kpi-value">${fmtMoney(report.totalWaste)}</div>
    </div>
    <div class="kpi-card warning">
      <div class="kpi-label">Costos y gastos</div>
      <div class="kpi-value">${fmtMoney(report.totalCosts)}</div>
    </div>
    <div class="kpi-card ${report.netProfit >= 0 ? 'success' : 'danger'}">
      <div class="kpi-label">Utilidad neta estimada</div>
      <div class="kpi-value">${fmtMoney(report.netProfit)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Tickets vendidos</div>
      <div class="kpi-value">${report.totalTickets}</div>
    </div>
  `;
}

function renderChart(byDay) {
  const container = document.getElementById('day-chart');
  if (!byDay || byDay.length === 0) {
    container.innerHTML = `<div class="empty-state">Sin ventas en el rango seleccionado.</div>`;
    return;
  }
  const max = Math.max(...byDay.map((d) => d.total), 1);
  container.innerHTML = byDay
    .map((d) => {
      const heightPct = Math.max(4, Math.round((d.total / max) * 100));
      const label = new Date(d.day + 'T00:00:00').toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
      return `
      <div class="bar-col">
        <div class="bar-value">${fmtMoney(d.total)}</div>
        <div class="bar" style="height:${heightPct}%"></div>
        <div class="bar-label">${label}</div>
      </div>
    `;
    })
    .join('');
}

function renderTopProducts(list) {
  const tbody = document.getElementById('top-products-tbody');
  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Sin ventas registradas.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.unidades}</td><td>${fmtMoney(p.total)}</td></tr>`)
    .join('');
}

function renderCosts() {
  const tbody = document.getElementById('costs-tbody');
  if (currentCosts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Sin costos registrados en este rango.</div></td></tr>`;
    return;
  }
  const CAT_LABEL = { fijo: 'Fijo', variable: 'Variable', insumo: 'Insumos', servicio: 'Servicios' };
  tbody.innerHTML = currentCosts
    .map(
      (c) => `
    <tr>
      <td>${c.date}</td>
      <td>${escapeHtml(c.concept)}</td>
      <td>${CAT_LABEL[c.category] || c.category}</td>
      <td>${fmtMoney(c.amount)}</td>
      <td><button class="btn btn-danger btn-sm" data-remove="${c.id}">Eliminar</button></td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar este registro de costo?')) return;
      await window.db.costs.remove(Number(b.dataset.remove));
      toast('Costo eliminado.', 'success');
      loadReport();
    })
  );
}

document.getElementById('btn-filter').addEventListener('click', loadReport);

document.getElementById('btn-new-cost').addEventListener('click', () => {
  document.getElementById('cost-concept').value = '';
  document.getElementById('cost-amount').value = '';
  document.getElementById('cost-category').value = 'variable';
  document.getElementById('cost-date').value = todayISO();
  openModal('cost-modal');
});

document.getElementById('btn-cancel-cost').addEventListener('click', () => closeModal('cost-modal'));

document.getElementById('btn-save-cost').addEventListener('click', async () => {
  const concept = document.getElementById('cost-concept').value.trim();
  const category = document.getElementById('cost-category').value;
  const amount = document.getElementById('cost-amount').value;
  const date = document.getElementById('cost-date').value || todayISO();

  if (!concept || !amount) {
    toast('Concepto y monto son obligatorios.', 'error');
    return;
  }

  try {
    await window.db.costs.create({ concept, category, amount: Number(amount), date });
    toast('Costo registrado.', 'success');
    closeModal('cost-modal');
    loadReport();
  } catch (err) {
    toast('No se pudo registrar el costo.', 'error');
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', () => {
  guardSession(['admin']);
  document.getElementById('filter-from').value = firstOfMonthISO();
  document.getElementById('filter-to').value = todayISO();
  loadReport();
});
