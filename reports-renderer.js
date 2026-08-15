let currentRange = 'today';
let customFrom = null;
let customTo = null;

function todayISO() {
  return localISODate();
}

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localISODate(d);
}

function mondayISO() {
  const d = new Date();
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return localISODate(d);
}

function firstOfMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getRange() {
  if (currentRange === 'today') return { dateFrom: todayISO(), dateTo: todayISO() };
  if (currentRange === 'week') return { dateFrom: mondayISO(), dateTo: todayISO() };
  if (currentRange === 'month') return { dateFrom: firstOfMonthISO(), dateTo: todayISO() };
  return { dateFrom: customFrom || todayISO(), dateTo: customTo || todayISO() };
}

document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;
    document.getElementById('custom-range').style.display = currentRange === 'custom' ? 'flex' : 'none';
    if (currentRange !== 'custom') loadReport();
  });
});

document.getElementById('btn-apply-custom').addEventListener('click', () => {
  customFrom = document.getElementById('filter-from').value;
  customTo = document.getElementById('filter-to').value;
  loadReport();
});

async function loadReport() {
  const { dateFrom, dateTo } = getRange();
  const report = await window.db.reports.profitability({ dateFrom, dateTo });
  renderKpis(report);
  renderChart(report.byDay);
  renderPayments(report.byPayment);
  renderTopProducts(report.topProducts);
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
      <div class="kpi-label">Tickets</div>
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
      </div>`;
    })
    .join('');
}

const PAYMENT_LABELS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

function renderPayments(byPayment) {
  const tbody = document.getElementById('payment-tbody');
  if (!byPayment || byPayment.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Sin ventas registradas.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = byPayment
    .map((p) => `<tr><td>${PAYMENT_LABELS[p.payment_method] || p.payment_method}</td><td>${p.tickets}</td><td>${fmtMoney(p.total)}</td></tr>`)
    .join('');
}

function renderTopProducts(list) {
  const tbody = document.getElementById('top-products-tbody');
  if (!list || list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Sin ventas registradas.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = list
    .map((p) => `<tr><td>${p.name}</td><td>${p.unidades}</td><td>${fmtMoney(p.total)}</td></tr>`)
    .join('');
}

// ---------------- EXPORTACIÓN ----------------
document.getElementById('export-grid').addEventListener('click', async (e) => {
  const card = e.target.closest('.export-card');
  if (!card) return;
  const { dateFrom, dateTo } = getRange();
  card.disabled = true;
  try {
    const result = await window.reportsAPI.exportCsv(card.dataset.type, dateFrom, dateTo);
    if (result.cancelled) {
      toast('Exportación cancelada.', 'default');
    } else {
      toast(`Archivo guardado en: ${result.path}`, 'success');
    }
  } catch (err) {
    toast('No se pudo exportar el reporte.', 'error');
  } finally {
    card.disabled = false;
  }
});

document.getElementById('btn-print-report').addEventListener('click', async () => {
  const { dateFrom, dateTo } = getRange();
  const btn = document.getElementById('btn-print-report');
  btn.disabled = true;
  btn.textContent = 'Generando...';
  try {
    await window.reportsAPI.printReport(dateFrom, dateTo);
  } catch (err) {
    toast('No se pudo generar el reporte imprimible.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Imprimir / Guardar como PDF';
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardSession(['admin']);
  if (!session) return;
  document.getElementById('filter-from').value = firstOfMonthISO();
  document.getElementById('filter-to').value = todayISO();
  loadReport();
});
