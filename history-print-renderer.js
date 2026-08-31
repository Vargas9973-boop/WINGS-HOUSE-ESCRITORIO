function fmt(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const TIPO_LABELS = {
  venta: 'Venta',
  para_llevar: 'Para Llevar',
  domicilio: 'Domicilio',
  beneficio_empleado: 'Beneficio Empleado',
  consumo_interno: 'Consumo Jefes',
  merma: 'Merma'
};

function renderHistoryReport({ rows, kpis, filters, settings }) {
  const root = document.getElementById('report-root');

  const bodyRows = rows.length
    ? rows.map((r) => `<tr>
        <td>${new Date(r.fecha).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${TIPO_LABELS[r.tipo] || r.tipo}</td>
        <td>${escapeHtml(r.detalle)}</td>
        <td>${fmt(r.total)}</td>
        <td>${escapeHtml(r.metodoLabel)}</td>
        <td>${escapeHtml(r.autorizoCliente)}</td>
      </tr>`).join('')
    : `<tr><td colspan="6" class="empty">Sin movimientos en el periodo.</td></tr>`;

  const businessName = settings.business_name || 'KATSAM Sistema de gestión para restaurantes';

  root.innerHTML = `
    <div class="report-header">
      <img src="${escapeHtml(settings.logo_url || 'logo_saas.png')}" alt="logo">
      <div>
        <h1>${escapeHtml(businessName)}</h1>
        <p>${escapeHtml(settings.business_address || '')} · Tel: ${escapeHtml(settings.business_phone || '')}</p>
      </div>
    </div>
    <div class="report-period">
      <strong>Historial Unificado</strong> — periodo del ${filters.startDate || '—'} al ${filters.endDate || '—'}
      · Generado el ${new Date().toLocaleString('es-MX')}
    </div>

    <div class="kpi-row">
      <div class="kpi-box"><div class="label">Ventas totales</div><div class="value">${fmt(kpis.ventasTotales)}</div></div>
      <div class="kpi-box"><div class="label">Consumo Interno</div><div class="value">${fmt(kpis.consumoInterno)}</div></div>
      <div class="kpi-box"><div class="label">Beneficio Empleados</div><div class="value">${fmt(kpis.beneficioEmpleados)}</div></div>
      <div class="kpi-box"><div class="label">Para Llevar</div><div class="value">${fmt(kpis.paraLlevar)}</div></div>
      <div class="kpi-box"><div class="label">Domicilio</div><div class="value">${fmt(kpis.domicilio)}</div></div>
      <div class="kpi-box"><div class="label">Merma total</div><div class="value">${fmt(kpis.mermaTotal)}</div></div>
    </div>

    <h2 class="section-title">Movimientos</h2>
    <table>
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Total</th><th>Método</th><th>Autorizó / Cliente</th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>

    <div class="report-footer">${escapeHtml(businessName)} — Historial generado automáticamente por el sistema administrativo.</div>
  `;
}

window.historyReportWindowAPI.onReportData((payload) => {
  renderHistoryReport(payload);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(() => window.historyReportWindowAPI.notifyRendered(), 150);
    });
  });
});
