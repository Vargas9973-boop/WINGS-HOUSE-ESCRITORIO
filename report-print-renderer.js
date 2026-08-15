function fmt(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function renderReport({ report, costsList, wasteList, settings }) {
  const root = document.getElementById('report-root');

  const topProductsRows = report.topProducts.length
    ? report.topProducts.map((p) => `<tr><td>${escapeHtml(p.name)}</td><td>${p.unidades}</td><td>${fmt(p.total)}</td></tr>`).join('')
    : `<tr><td colspan="3" class="empty">Sin ventas en el periodo.</td></tr>`;

  const byDayRows = report.byDay.length
    ? report.byDay.map((d) => `<tr><td>${d.day}</td><td>${fmt(d.total)}</td></tr>`).join('')
    : `<tr><td colspan="2" class="empty">Sin ventas en el periodo.</td></tr>`;

  const costsRows = costsList.length
    ? costsList.map((c) => `<tr><td>${c.date}</td><td>${escapeHtml(c.concept)}</td><td>${escapeHtml(c.category)}</td><td>${fmt(c.amount)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">Sin costos registrados en el periodo.</td></tr>`;

  const wasteRows = wasteList.length
    ? wasteList.map((w) => `<tr><td>${w.created_at}</td><td>${escapeHtml(w.item_name)}</td><td>${w.quantity} ${escapeHtml(w.unit)}</td><td>${escapeHtml(w.reason)}</td><td>${fmt(w.cost)}</td></tr>`).join('')
    : `<tr><td colspan="5" class="empty">Sin merma registrada en el periodo.</td></tr>`;

  root.innerHTML = `
    <div class="report-header">
      <img src="logo.png" alt="logo">
      <div>
        <h1>${escapeHtml(settings.business_name || 'Wings House')}</h1>
        <p>${escapeHtml(settings.business_address || '')} · Tel: ${escapeHtml(settings.business_phone || '')}</p>
      </div>
    </div>
    <div class="report-period">
      <strong>Reporte de operación</strong> — periodo del ${report.dateFrom} al ${report.dateTo}
      · Generado el ${new Date().toLocaleString('es-MX')}
    </div>

    <div class="kpi-row">
      <div class="kpi-box"><div class="label">Ventas totales</div><div class="value">${fmt(report.totalSales)}</div></div>
      <div class="kpi-box"><div class="label">Tickets</div><div class="value">${report.totalTickets}</div></div>
      <div class="kpi-box"><div class="label">Merma</div><div class="value">${fmt(report.totalWaste)}</div></div>
      <div class="kpi-box"><div class="label">Costos y gastos</div><div class="value">${fmt(report.totalCosts)}</div></div>
      <div class="kpi-box"><div class="label">Utilidad neta</div><div class="value">${fmt(report.netProfit)}</div></div>
    </div>

    <h2 class="section-title">Ventas por día</h2>
    <table><thead><tr><th>Fecha</th><th>Total</th></tr></thead><tbody>${byDayRows}</tbody></table>

    <h2 class="section-title">Productos más vendidos</h2>
    <table><thead><tr><th>Producto</th><th>Unidades</th><th>Total</th></tr></thead><tbody>${topProductsRows}</tbody></table>

    <h2 class="section-title">Costos y gastos del periodo</h2>
    <table><thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th>Monto</th></tr></thead><tbody>${costsRows}</tbody></table>

    <h2 class="section-title">Merma del periodo</h2>
    <table><thead><tr><th>Fecha</th><th>Insumo</th><th>Cantidad</th><th>Motivo</th><th>Costo</th></tr></thead><tbody>${wasteRows}</tbody></table>

    <div class="report-footer">Wings House — Reporte generado automáticamente por el sistema administrativo.</div>
  `;
}

window.reportWindowAPI.onReportData((payload) => {
  renderReport(payload);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(() => window.reportWindowAPI.notifyRendered(), 150);
    });
  });
});
