// history-renderer.js — Módulo "Historial Unificado": ventas (mostrador,
// para llevar, domicilio), beneficio de empleado, consumo interno (jefes) y
// merma en una sola tabla filtrable, con KPIs del rango y exportación.

let currentRange = 'today';
let customFrom = null;
let customTo = null;
let currentRows = [];
let expandedRowId = null;
let payrollPaydayNumber = 6;
let currentTicketSaleId = null;

const TIPO_LABELS = {
  venta: 'Venta',
  para_llevar: 'Para Llevar',
  domicilio: 'Venta Domicilio',
  beneficio_empleado: 'Beneficio Empleado',
  consumo_interno: 'Consumo Jefes',
  merma: 'Merma'
};

function todayISO() {
  return localISODate();
}

function isoOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localISODate(d);
}

function firstOfMonthISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function getRange() {
  if (currentRange === 'today') return { startDate: todayISO(), endDate: todayISO() };
  if (currentRange === 'yesterday') return { startDate: isoOffset(-1), endDate: isoOffset(-1) };
  if (currentRange === 'month') return { startDate: firstOfMonthISO(), endDate: todayISO() };
  return { startDate: customFrom || todayISO(), endDate: customTo || todayISO() };
}

document.querySelectorAll('.range-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRange = btn.dataset.range;

    if (currentRange === 'week') {
      // Misma semana laboral que Nómina (día de pago configurable en
      // Ajustes), no lunes-domingo fijo.
      try {
        const range = await window.db.payroll.getWeekRange(payrollPaydayNumber);
        document.getElementById('hist-from').value = range.start;
        document.getElementById('hist-to').value = range.end;
        loadHistory();
      } catch (err) {
        toast('No se pudo calcular la semana laboral.', 'error');
      }
      return;
    }

    if (currentRange !== 'custom') {
      const { startDate, endDate } = getRange();
      document.getElementById('hist-from').value = startDate;
      document.getElementById('hist-to').value = endDate;
      loadHistory();
    }
  });
});

function currentFilters() {
  // Todos los botones rápidos (incluido "Esta semana", async) ya escriben
  // el rango resuelto en los inputs antes de llamar loadHistory(), así que
  // los inputs son la fuente de verdad aquí.
  return {
    startDate: document.getElementById('hist-from').value,
    endDate: document.getElementById('hist-to').value,
    tipo: document.getElementById('hist-tipo').value,
    employeeName: document.getElementById('hist-empleado').value || null,
    paymentMethod: document.getElementById('hist-metodo').value || null
  };
}

async function loadEmployeesFilter() {
  try {
    const employees = await window.db.employees.getAll();
    const select = document.getElementById('hist-empleado');
    select.innerHTML = '<option value="">Todos</option>' +
      employees.map((e) => `<option value="${escapeHtmlHist(e.name)}">${escapeHtmlHist(e.name)}</option>`).join('');
  } catch (err) {
    console.error('No se pudieron cargar empleados para el filtro:', err);
  }
}

async function loadHistory() {
  const tbody = document.getElementById('hist-tbody');
  tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Cargando...</div></td></tr>`;
  try {
    const filters = currentFilters();
    const { rows, kpis } = await window.historyAPI.get(filters);
    currentRows = rows;
    renderKpis(kpis);
    renderTable(rows);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">No se pudo cargar el historial.</div></td></tr>`;
    toast('No se pudo cargar el historial.', 'error');
  }
}

function renderKpis(kpis) {
  document.getElementById('hist-kpi-grid').innerHTML = `
    <div class="kpi-card success">
      <div class="kpi-label">Ventas totales</div>
      <div class="kpi-value">${fmtMoney(kpis.ventasTotales)}</div>
    </div>
    <div class="kpi-card warning">
      <div class="kpi-label">Consumo Interno</div>
      <div class="kpi-value">${fmtMoney(kpis.consumoInterno)}</div>
    </div>
    <div class="kpi-card warning">
      <div class="kpi-label">Beneficio Empleados</div>
      <div class="kpi-value">${fmtMoney(kpis.beneficioEmpleados)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Para Llevar</div>
      <div class="kpi-value">${fmtMoney(kpis.paraLlevar)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Domicilio</div>
      <div class="kpi-value">${fmtMoney(kpis.domicilio)}</div>
    </div>
    <div class="kpi-card danger">
      <div class="kpi-label">Merma total</div>
      <div class="kpi-value">${fmtMoney(kpis.mermaTotal)}</div>
    </div>
    <div class="kpi-card warning">
      <div class="kpi-label">Costo de venta del rango (COGS)</div>
      <div class="kpi-value">${fmtMoney(kpis.cogs)}</div>
    </div>
    <div class="kpi-card ${kpis.grossProfit >= 0 ? 'success' : 'danger'}">
      <div class="kpi-label">Utilidad bruta del rango</div>
      <div class="kpi-value">${fmtMoney(kpis.grossProfit)}</div>
    </div>
  `;
}

function productDetailTableHtml(items) {
  if (!items || items.length === 0) {
    return `<div class="empty-state">Sin productos asociados (merma/consumo interno: ver Detalle).</div>`;
  }
  const rows = items
    .map(
      (it) => `<tr>
        <td>${escapeHtmlHist(it.name)}</td>
        <td>${it.quantity}</td>
        <td>${fmtMoney(it.unit_price)}</td>
        <td>${fmtMoney(it.subtotal)}</td>
      </tr>`
    )
    .join('');
  return `
    <table class="data-table" style="margin:0;">
      <thead><tr><th>Producto</th><th>Cant</th><th>Precio unit</th><th>Subtotal</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTable(rows) {
  const tbody = document.getElementById('hist-tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Sin movimientos en el rango seleccionado.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map((r) => {
      const fecha = new Date(r.fecha).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      const puedeExpandir = r.items && r.items.length > 0;
      const isExpanded = expandedRowId === r.id;
      const accion = r.saleId
        ? `<button class="btn btn-outline btn-sm" data-ver-ticket="${r.id}">Ver ticket</button>`
        : '—';
      const detalleCell = puedeExpandir
        ? `<button class="btn-expand-row" data-expand="${r.id}" title="Ver productos">${isExpanded ? '▾' : '▸'} ${escapeHtmlHist(r.detalle)}</button>`
        : escapeHtmlHist(r.detalle);

      const mainRow = `<tr>
        <td>${fecha}</td>
        <td>${TIPO_LABELS[r.tipo] || r.tipo}</td>
        <td>${detalleCell}</td>
        <td>${fmtMoney(r.total)}</td>
        <td>${escapeHtmlHist(r.metodoLabel)}</td>
        <td>${escapeHtmlHist(r.autorizoCliente)}</td>
        <td>${accion}</td>
      </tr>`;

      const detailRow = isExpanded
        ? `<tr class="hist-detail-row"><td colspan="7">${productDetailTableHtml(r.items)}</td></tr>`
        : '';

      return mainRow + detailRow;
    })
    .join('');

  tbody.querySelectorAll('[data-ver-ticket]').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTicketModal(btn.dataset.verTicket);
    })
  );

  tbody.querySelectorAll('[data-expand]').forEach((btn) =>
    btn.addEventListener('click', () => {
      expandedRowId = expandedRowId === btn.dataset.expand ? null : btn.dataset.expand;
      renderTable(currentRows);
    })
  );
}

function openTicketModal(rowId) {
  const row = currentRows.find((r) => r.id === rowId);
  if (!row) return;

  currentTicketSaleId = row.saleId;
  document.getElementById('hist-ticket-title').textContent = `Ticket ${row.folio || ''}`;

  const itemsHtml = row.items && row.items.length
    ? row.items.map((it) => {
        const modifiersHtml = (it.modifiers || [])
          .map((name) => `<div style="color:#f97316;font-size:12px;font-weight:700;padding-left:8px;">• ${escapeHtmlHist(name)}</div>`)
          .join('');
        return `<div class="ticket-row"><span>${it.quantity}x ${escapeHtmlHist(it.name)}</span><span>${fmtMoney(it.subtotal)}</span></div>${modifiersHtml}`;
      }).join('')
    : `<div class="empty-state">Sin artículos.</div>`;

  const extraHtml = row.tipo === 'domicilio'
    ? `
      <div class="ticket-sep"></div>
      <div class="ticket-row"><span>Cliente</span><span>${escapeHtmlHist(row.autorizoCliente)}</span></div>
      <div class="ticket-row"><span>Teléfono</span><span>${escapeHtmlHist(row.telefono || '—')}</span></div>
      <div class="ticket-row"><span>Dirección</span><span>${escapeHtmlHist(row.direccion || '—')}</span></div>
      <div class="ticket-row"><span>Repartidor</span><span>${escapeHtmlHist(row.repartidor || '—')}</span></div>`
    : '';

  document.getElementById('hist-ticket-body').innerHTML = `
    <div class="ticket-row"><span>Tipo</span><span>${TIPO_LABELS[row.tipo] || row.tipo}</span></div>
    <div class="ticket-sep"></div>
    ${itemsHtml}
    <div class="ticket-sep"></div>
    <div class="ticket-row total"><span>Total</span><span>${fmtMoney(row.total)}</span></div>
    <div class="ticket-row"><span>Método</span><span>${escapeHtmlHist(row.metodoLabel)}</span></div>
    ${extraHtml}
  `;

  openModal('hist-ticket-modal');
}

document.getElementById('btn-close-hist-ticket').addEventListener('click', () => closeModal('hist-ticket-modal'));

document.getElementById('btn-reimprimir-hist-ticket').addEventListener('click', async () => {
  if (!currentTicketSaleId) {
    toast('Este movimiento no tiene ticket para reimprimir.', 'error');
    return;
  }
  const btn = document.getElementById('btn-reimprimir-hist-ticket');
  btn.disabled = true;
  try {
    const result = await window.printerAPI.printTicket(currentTicketSaleId);
    if (result && result.success) {
      toast('Ticket enviado a la impresora.', 'success');
    } else if (result && result.reason === 'cancelled') {
      // el usuario canceló el diálogo de impresión, no es un error
    } else {
      toast('No se pudo reimprimir el ticket.', 'error');
    }
  } catch (err) {
    toast('No se pudo reimprimir el ticket.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-buscar-historial').addEventListener('click', () => {
  customFrom = document.getElementById('hist-from').value;
  customTo = document.getElementById('hist-to').value;
  currentRange = 'custom';
  document.querySelectorAll('.range-btn').forEach((b) => b.classList.toggle('active', b.dataset.range === 'custom'));
  loadHistory();
});
document.getElementById('hist-tipo').addEventListener('change', loadHistory);
document.getElementById('hist-empleado').addEventListener('change', loadHistory);
document.getElementById('hist-metodo').addEventListener('change', loadHistory);

document.getElementById('btn-export-csv').addEventListener('click', async () => {
  const btn = document.getElementById('btn-export-csv');
  btn.disabled = true;
  try {
    const result = await window.historyAPI.exportCsv(currentFilters());
    if (result.cancelled) {
      toast('Exportación cancelada.', 'default');
    } else {
      toast(`Archivo guardado en: ${result.path}`, 'success');
    }
  } catch (err) {
    toast('No se pudo exportar el historial.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-export-pdf').addEventListener('click', async () => {
  const btn = document.getElementById('btn-export-pdf');
  btn.disabled = true;
  btn.textContent = 'Generando...';
  try {
    await window.historyAPI.exportPdf(currentFilters());
  } catch (err) {
    toast('No se pudo generar el PDF.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Exportar a PDF';
  }
});

function escapeHtmlHist(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardSession(['admin']);
  if (!session) return;
  document.getElementById('hist-from').value = todayISO();
  document.getElementById('hist-to').value = todayISO();

  try {
    const settings = await window.db.payroll.getSettings();
    payrollPaydayNumber = settings.dayNumber;
  } catch (err) {
    payrollPaydayNumber = 6;
  }

  await loadEmployeesFilter();
  loadHistory();
});
