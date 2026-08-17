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

const PAYMENT_LABELS = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito_nomina: 'Crédito Nómina',
  beneficio_empleado: 'Beneficio Empleado'
};

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

// ---------------- HISTORIAL DE CORTES DE CAJA ----------------
const ESTADO_LABELS = { cerrado: 'Cerrado', abierto: 'Abierto' };
let cortesHistorial = [];
let selectedCorteFecha = null;

async function loadCortesHistorial() {
  const dateFrom = document.getElementById('cortes-from').value;
  const dateTo = document.getElementById('cortes-to').value;
  try {
    cortesHistorial = await window.reportsAPI.cortes(dateFrom, dateTo);
  } catch (err) {
    toast('No se pudo cargar el historial de cortes.', 'error');
    cortesHistorial = [];
  }
  renderCortesHistorial();
  selectedCorteFecha = null;
  document.getElementById('corte-detalle').innerHTML = `<div class="empty-state">Selecciona una fecha del historial.</div>`;
  document.getElementById('btn-reimprimir-corte').disabled = true;
}

function renderCortesHistorial() {
  const tbody = document.getElementById('cortes-tbody');
  if (!cortesHistorial || cortesHistorial.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Sin cortes en el rango seleccionado.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = cortesHistorial
    .map((c) => {
      const estado = c.cerrado_at ? ESTADO_LABELS.cerrado : ESTADO_LABELS.abierto;
      const efectivoReal = c.efectivo_real != null ? fmtMoney(c.efectivo_real) : '—';
      return `<tr data-fecha="${c.fecha}" style="cursor:pointer;">
        <td>${c.fecha}</td>
        <td>${fmtMoney(c.fondo_inicial || 0)}</td>
        <td>${efectivoReal}</td>
        <td>${estado}</td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('tr[data-fecha]').forEach((row) =>
    row.addEventListener('click', () => loadCorteDetalle(row.dataset.fecha))
  );
}

async function loadCorteDetalle(fecha) {
  selectedCorteFecha = fecha;
  const detalle = document.getElementById('corte-detalle');
  detalle.innerHTML = `<div class="empty-state">Cargando...</div>`;
  try {
    const [resumen, corte] = await Promise.all([
      window.corteAPI.getResumen(fecha),
      window.corteAPI.getByFecha(fecha)
    ]);

    const fondoInicial = Number(corte?.fondo_inicial ?? resumen.fondoInicial) || 0;
    const efectivoNeto = (resumen.ventasPorPago.efectivo || 0) - (resumen.salidasPorPago.efectivo || 0);
    const esperado = fondoInicial + efectivoNeto;
    const efectivoReal = corte?.efectivo_real != null ? Number(corte.efectivo_real) : null;
    const diferencia = efectivoReal != null ? efectivoReal - esperado : null;
    const diffClass = diferencia == null ? '' : diferencia < 0 ? 'danger' : diferencia > 0 ? 'warning' : 'success';
    const totalSalidasDia =
      (resumen.salidasPorPago.efectivo || 0) + (resumen.salidasPorPago.tarjeta || 0) + (resumen.salidasPorPago.transferencia || 0);

    detalle.innerHTML = `
      <div class="ticket-row"><span>Fondo inicial</span><span>${fmtMoney(fondoInicial)}</span></div>
      <div class="ticket-row"><span>Ventas totales</span><span>${fmtMoney(resumen.ventaTotal)}</span></div>
      ${
        resumen.beneficioEmpleados || resumen.creditoNominaHoy
          ? `
      <div class="ticket-row"><span>Beneficio Empleados</span><span>${fmtMoney(resumen.beneficioEmpleados || 0)}</span></div>
      <div class="ticket-row"><span>Crédito Nómina (no afecta caja)</span><span>${fmtMoney(resumen.creditoNominaHoy || 0)}</span></div>`
          : ''
      }
      <div class="ticket-row"><span>Ingresos (efectivo)</span><span>${fmtMoney(resumen.ventasPorPago.efectivo || 0)}</span></div>
      <div class="ticket-row"><span>Egresos (salidas)</span><span>-${fmtMoney(totalSalidasDia)}</span></div>
      <div class="ticket-row total highlight"><span>Esperado en cajón</span><span>${fmtMoney(esperado)}</span></div>
      <div class="ticket-row"><span>Efectivo real</span><span>${efectivoReal != null ? fmtMoney(efectivoReal) : '—'}</span></div>
      <div class="ticket-row total ${diffClass}"><span>Diferencia</span><span>${diferencia != null ? (diferencia >= 0 ? '+' : '') + fmtMoney(diferencia) : '—'}</span></div>
    `;
    document.getElementById('btn-reimprimir-corte').disabled = false;
  } catch (err) {
    detalle.innerHTML = `<div class="empty-state">No se pudo cargar el detalle de ese corte.</div>`;
    document.getElementById('btn-reimprimir-corte').disabled = true;
  }
}

document.getElementById('btn-buscar-cortes').addEventListener('click', loadCortesHistorial);

document.getElementById('btn-reimprimir-corte').addEventListener('click', async () => {
  if (!selectedCorteFecha) return;
  const btn = document.getElementById('btn-reimprimir-corte');
  btn.disabled = true;
  try {
    await imprimirTicketCorte(selectedCorteFecha);
  } finally {
    btn.disabled = false;
  }
});

// ---------------- DEDUCCIONES DE NÓMINA PENDIENTES ----------------
async function loadPayrollPendientes() {
  const tbody = document.getElementById('payroll-pendientes-tbody');
  try {
    const rows = await window.db.payroll.pendientes(mondayISO());
    if (!rows || rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Sin deducciones pendientes esta semana.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map(
        (r) => `<tr>
        <td>${escapeHtmlReports(r.employeeName)}</td>
        <td>${fmtMoney(r.creditoSemanal)}</td>
        <td>${fmtMoney(r.efectivoExcedente)}</td>
        <td>${fmtMoney(r.totalDeducir)}</td>
      </tr>`
      )
      .join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">No se pudieron cargar las deducciones pendientes.</div></td></tr>`;
  }
}

function escapeHtmlReports(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardSession(['admin']);
  if (!session) return;
  document.getElementById('filter-from').value = firstOfMonthISO();
  document.getElementById('filter-to').value = todayISO();
  document.getElementById('cortes-from').value = firstOfMonthISO();
  document.getElementById('cortes-to').value = todayISO();
  loadReport();
  loadCortesHistorial();
  loadPayrollPendientes();
});
