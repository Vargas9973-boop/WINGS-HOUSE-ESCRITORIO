// ticket-corte.js — Genera e imprime el ticket 58mm del corte de caja.
// Compartido entre corte.html (corte del día) y reports.html (reimpresión
// de cortes históricos vía el historial de Reportes).

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function imprimirTicketCorte(fecha) {
  try {
    const fechaInput = fecha || document.getElementById('corte-fecha')?.value || localISODate();
    const resumen = await window.corteAPI.getResumen(fechaInput);

    const fondoInicial = Number(resumen.fondoInicial ?? resumen.fondo_inicial) || 0;
    const ventasPorPago = resumen.ventasPorPago || resumen.ventas_por_pago || {};
    const salidasPorPago = resumen.salidasPorPago || resumen.salidas_por_pago || {};
    const ventasEfectivo = Number(ventasPorPago.efectivo) || 0;
    const ventasTarjeta = Number(ventasPorPago.tarjeta) || 0;
    const ventasTransferencia = Number(ventasPorPago.transferencia) || 0;
    const ventasTotal = Number(resumen.ventaTotal ?? resumen.venta_total) || (ventasEfectivo + ventasTarjeta + ventasTransferencia);
    const salidasEfectivo = Number(salidasPorPago.efectivo) || 0;
    const salidasTarjeta = Number(salidasPorPago.tarjeta) || 0;
    const salidasTransferencia = Number(salidasPorPago.transferencia) || 0;
    const totalSalidas = salidasEfectivo + salidasTarjeta + salidasTransferencia;
    const efectivoEsperado = fondoInicial + ventasEfectivo - salidasEfectivo;
    const efectivoRealRaw = resumen.efectivoReal ?? resumen.efectivo_real;
    const efectivoReal = efectivoRealRaw != null ? Number(efectivoRealRaw) : null;
    const diferencia = efectivoReal != null ? efectivoReal - efectivoEsperado : null;
    const movimientos = Array.isArray(resumen.movimientos) ? resumen.movimientos : [];
    const beneficioEmpleados = Number(resumen.beneficioEmpleados ?? resumen.beneficio_empleados) || 0;
    const creditoNominaHoy = Number(resumen.creditoNominaHoy ?? resumen.credito_nomina_hoy) || 0;

    const movimientosHtml = movimientos.length
      ? movimientos.map((m) => `
      <div class="row"><span>${escapeHtml(m.concepto || m.tipo || 'Salida')}</span><span>-$${(Number(m.monto) || 0).toFixed(2)}</span></div>`).join('')
      : '<div class="row"><span>Sin salidas registradas</span><span></span></div>';

    const html = `
    <html><head><meta charset="utf-8"><style>
      @page{margin:0}
      body{width:48mm;font-family:'Courier New',monospace;font-size:10px;margin:0;padding:4mm;color:#000}
      .c{text-align:center}.r{text-align:right}
      .sep{border-top:1px dashed #000;margin:6px 0}
      .row{display:flex;justify-content:space-between}
      .b{font-weight:bold} .lg{font-size:13px}
    </style></head><body>
      <div class="c b lg">WINGS HOUSE</div>
      <div class="c">CORTE DE CAJA</div>
      <div class="c">${resumen.fecha || fechaInput}</div>
      <div class="sep"></div>
      <div class="row"><span>Fondo inicial:</span><span>$${fondoInicial.toFixed(2)}</span></div>
      <div class="sep"></div>
      <div class="row"><span>Ventas efectivo:</span><span>$${ventasEfectivo.toFixed(2)}</span></div>
      <div class="row"><span>Ventas tarjeta:</span><span>$${ventasTarjeta.toFixed(2)}</span></div>
      <div class="row"><span>Ventas transferencia:</span><span>$${ventasTransferencia.toFixed(2)}</span></div>
      <div class="row b"><span>Ventas total:</span><span>$${ventasTotal.toFixed(2)}</span></div>
      ${beneficioEmpleados || creditoNominaHoy ? `
      <div class="sep"></div>
      <div class="row"><span>Beneficio Empleados:</span><span>$${beneficioEmpleados.toFixed(2)}</span></div>
      <div class="row"><span>Crédito Nómina (no afecta caja):</span><span>$${creditoNominaHoy.toFixed(2)}</span></div>` : ''}
      <div class="sep"></div>
      <div class="c b">SALIDAS</div>
      ${movimientosHtml}
      <div class="row b"><span>Total salidas:</span><span>-$${totalSalidas.toFixed(2)}</span></div>
      <div class="sep"></div>
      <div class="row b lg"><span>Efectivo esperado:</span><span>$${efectivoEsperado.toFixed(2)}</span></div>
      ${efectivoReal != null ? `
      <div class="row"><span>Efectivo real:</span><span>$${efectivoReal.toFixed(2)}</span></div>
      <div class="row"><span>Diferencia:</span><span>${diferencia >= 0 ? '+' : ''}$${diferencia.toFixed(2)}</span></div>` : ''}
      <div class="sep"></div>
      <div class="c">Gracias</div>
    </body></html>`;

    await window.corteAPI.printTicket(html);
  } catch(e) {
    console.error(e);
    alert('Error: '+e.message);
  }
}
