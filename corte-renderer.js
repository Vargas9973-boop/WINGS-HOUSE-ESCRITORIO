// corte-renderer.js — Módulo "Corte de Caja".
//
// Fondo inicial y cierre se guardan en cash_cuts (una fila por fecha).
// Ventas y salidas del día NUNCA se congelan en ese renglón: se recalculan
// en vivo desde "sales" y "cash_movements" cada vez que se carga la pantalla
// o se agrega/elimina una salida, para que el ticket refleje el estado real
// hasta el instante de "Cerrar corte".
//
// IMPORTANTE: comanda_set_delivery (usado al marcar "En camino" desde
// Comandas) NO crea salidas de caja. Todo lo que aparece aquí como "Salidas"
// se capturó a mano con el botón "+ Agregar salida".

let corteData = null;
let currentFecha = todayISO();

const CATEGORIA_LABELS = { repartidores: 'Repartidores', basura: 'Basura', insumos: 'Insumos', otros: 'Otros' };
const METODO_LABELS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

function todayISO() {
  return localISODate();
}

function isToday() {
  return currentFecha === todayISO();
}

function fmtFechaLarga(fechaISO) {
  const d = new Date(`${fechaISO}T00:00:00`);
  return d.toLocaleDateString('es-MX', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function totalSalidas(salidasPorPago) {
  return (salidasPorPago.efectivo || 0) + (salidasPorPago.tarjeta || 0) + (salidasPorPago.transferencia || 0);
}

async function loadCorte() {
  currentFecha = document.getElementById('corte-fecha').value || todayISO();
  try {
    corteData = await window.corteAPI.getResumen(currentFecha);
  } catch (err) {
    toast('No se pudo cargar el corte de caja.', 'error');
    return;
  }

  document.getElementById('fondo-inicial-input').value = corteData.fondoInicial || 0;
  document.getElementById('efectivo-real-input').value = corteData.efectivoReal != null ? corteData.efectivoReal : '';

  renderStatus();
  renderMovimientos();
  renderDineroEnCalle();
  renderTicket();
  updateEditability();
}

// Aviso en pantalla (no en el ticket imprimible) de efectivo que ya se
// cobró pero que todavía no regresa al local: no cuenta como faltante, pero
// tampoco debe darse por sentado que ya está en el cajón. Es un snapshot en
// vivo (getPendingDriverMoney no filtra por fecha), así que se muestra sin
// importar qué día esté seleccionado arriba.
function renderDineroEnCalle() {
  const panel = document.getElementById('dinero-en-calle-panel');
  const detalle = document.getElementById('dinero-en-calle-detalle');
  const lista = corteData.dineroEnCalle || [];

  if (lista.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'flex';
  detalle.innerHTML = lista
    .map((d) => `<div>${escapeHtml(d.driverName)}: ${d.pedidos} pedido(s) — ${fmtMoney(d.aRegresar)}</div>`)
    .join('') + `<div style="margin-top:6px; font-weight:800;">Total en calle: ${fmtMoney(corteData.dineroEnCalleTotal || 0)}</div>`;
}

function renderStatus() {
  const el = document.getElementById('corte-status');
  if (!isToday()) {
    el.textContent = 'Día anterior — solo lectura';
    el.className = 'readonly';
  } else if (corteData.cerrado) {
    el.textContent = `Corte cerrado${corteData.cerradoPor ? ' por ' + corteData.cerradoPor : ''}`;
    el.className = 'closed';
  } else {
    el.textContent = 'Corte abierto (hoy)';
    el.className = 'open';
  }
}

function updateEditability() {
  const editable = isToday() && !corteData.cerrado;
  document.getElementById('fondo-inicial-input').disabled = !editable;
  document.getElementById('btn-guardar-fondo').disabled = !editable;
  document.getElementById('btn-new-salida').disabled = !editable;
  document.getElementById('efectivo-real-input').disabled = !editable;
  document.getElementById('btn-cerrar-corte').disabled = !editable;
  document.querySelectorAll('#movimientos-tbody [data-remove]').forEach((b) => (b.disabled = !editable));
}

function renderMovimientos() {
  const tbody = document.getElementById('movimientos-tbody');
  const movimientos = corteData.movimientos || [];
  if (movimientos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Sin salidas registradas hoy.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = movimientos
    .map((m) => {
      const hora = new Date(m.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
      return `
    <tr>
      <td>${hora}</td>
      <td>${escapeHtml(m.concepto)}</td>
      <td>${CATEGORIA_LABELS[m.categoria_costo] || m.categoria_costo}</td>
      <td>${METODO_LABELS[m.metodo_pago] || m.metodo_pago}</td>
      <td>${fmtMoney(m.monto)}</td>
      <td><button class="btn btn-danger btn-sm" data-remove="${m.id}">Eliminar</button></td>
    </tr>`;
    })
    .join('');

  tbody.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('¿Eliminar esta salida de caja?')) return;
      try {
        await window.corteAPI.removeMovimiento(Number(b.dataset.remove));
        toast('Salida eliminada.', 'success');
        loadCorte();
      } catch (err) {
        toast('No se pudo eliminar la salida.', 'error');
      }
    })
  );
}

function renderTicket() {
  const d = corteData;
  const fondoInicial = Number(document.getElementById('fondo-inicial-input').value) || 0;

  const efectivoNeto = (d.ventasPorPago.efectivo || 0) - (d.salidasPorPago.efectivo || 0);
  const tarjetaNeta = (d.ventasPorPago.tarjeta || 0) - (d.salidasPorPago.tarjeta || 0);
  const transferenciaNeta = (d.ventasPorPago.transferencia || 0) - (d.salidasPorPago.transferencia || 0);
  const esperadoCajon = fondoInicial + efectivoNeto;

  const efectivoRealRaw = document.getElementById('efectivo-real-input').value;
  const efectivoReal = efectivoRealRaw === '' ? null : Number(efectivoRealRaw);
  const diferencia = efectivoReal != null ? efectivoReal - esperadoCajon : null;
  const diffClass = diferencia == null ? '' : diferencia < 0 ? 'danger' : diferencia > 0 ? 'warning' : 'success';

  document.getElementById('ticket').innerHTML = `
    <div class="ticket-header">CORTE DE CAJA</div>
    <div class="ticket-subheader">${fmtFechaLarga(d.fecha)}</div>
    <div class="ticket-sep"></div>

    <div class="ticket-row"><span>Fondo inicial</span><span>${fmtMoney(fondoInicial)}</span></div>

    <div class="ticket-sep"></div>
    <div class="ticket-section">VENTAS</div>
    <div class="ticket-row"><span>Comida</span><span>${fmtMoney(d.ventaComida)}</span></div>
    <div class="ticket-row"><span>Envíos cobrados (${d.pedidosConEnvio})</span><span>${fmtMoney(d.ventaEnvios)}</span></div>
    <div class="ticket-row total"><span>Total ventas</span><span>${fmtMoney(d.ventaTotal)}</span></div>
    ${
      d.beneficioEmpleados || d.creditoNominaHoy
        ? `
    <div class="ticket-row"><span>Beneficio Empleados</span><span>${fmtMoney(d.beneficioEmpleados || 0)}</span></div>
    <div class="ticket-row"><span>Crédito Nómina (no afecta caja)</span><span>${fmtMoney(d.creditoNominaHoy || 0)}</span></div>`
        : ''
    }

    <div class="ticket-sep"></div>
    <div class="ticket-section">POR MÉTODO DE PAGO</div>
    <div class="ticket-row"><span>Efectivo</span><span>${fmtMoney(d.ventasPorPago.efectivo || 0)}</span></div>
    <div class="ticket-row"><span>Tarjeta</span><span>${fmtMoney(d.ventasPorPago.tarjeta || 0)}</span></div>
    <div class="ticket-row"><span>Transferencia</span><span>${fmtMoney(d.ventasPorPago.transferencia || 0)}</span></div>

    <div class="ticket-sep"></div>
    <div class="ticket-section">SALIDAS</div>
    <div class="ticket-row"><span>Efectivo</span><span>-${fmtMoney(d.salidasPorPago.efectivo || 0)}</span></div>
    <div class="ticket-row"><span>Tarjeta</span><span>-${fmtMoney(d.salidasPorPago.tarjeta || 0)}</span></div>
    <div class="ticket-row"><span>Transferencia</span><span>-${fmtMoney(d.salidasPorPago.transferencia || 0)}</span></div>
    <div class="ticket-row total"><span>Total salidas</span><span>-${fmtMoney(totalSalidas(d.salidasPorPago))}</span></div>

    <div class="ticket-sep"></div>
    <div class="ticket-section">RESUMEN</div>
    <div class="ticket-row"><span>Efectivo neto</span><span>${fmtMoney(efectivoNeto)}</span></div>
    <div class="ticket-row"><span>Tarjeta neta</span><span>${fmtMoney(tarjetaNeta)}</span></div>
    <div class="ticket-row"><span>Transferencia neta</span><span>${fmtMoney(transferenciaNeta)}</span></div>

    ${
      d.dineroEnCalleTotal > 0
        ? `
    <div class="ticket-sep"></div>
    <div class="ticket-row"><span>Dinero en calle (repartidores, no cuenta aquí)</span><span>${fmtMoney(d.dineroEnCalleTotal)}</span></div>`
        : ''
    }

    <div class="ticket-sep"></div>
    <div class="ticket-row total highlight"><span>Esperado en cajón</span><span>${fmtMoney(esperadoCajon)}</span></div>
    ${
      efectivoReal != null
        ? `
    <div class="ticket-row"><span>Efectivo real contado</span><span>${fmtMoney(efectivoReal)}</span></div>
    <div class="ticket-row total ${diffClass}"><span>Diferencia</span><span>${diferencia >= 0 ? '+' : ''}${fmtMoney(diferencia)}</span></div>`
        : ''
    }
  `;
}

// ==========================================================================
// EVENTOS
// ==========================================================================
document.getElementById('corte-fecha').addEventListener('change', loadCorte);

document.getElementById('fondo-inicial-input').addEventListener('input', () => {
  if (corteData) renderTicket();
});

document.getElementById('efectivo-real-input').addEventListener('input', () => {
  if (corteData) renderTicket();
});

document.getElementById('btn-guardar-fondo').addEventListener('click', async () => {
  const fondoInicial = document.getElementById('fondo-inicial-input').value;
  try {
    await window.corteAPI.setFondoInicial(currentFecha, Number(fondoInicial) || 0);
    toast('Fondo inicial guardado.', 'success');
    loadCorte();
  } catch (err) {
    toast('No se pudo guardar el fondo inicial.', 'error');
  }
});

document.getElementById('btn-new-salida').addEventListener('click', () => {
  document.getElementById('salida-concepto').value = '';
  document.getElementById('salida-monto').value = '';
  document.getElementById('salida-metodo').value = 'efectivo';
  document.getElementById('salida-categoria').value = 'otros';
  openModal('salida-modal');
});

document.getElementById('btn-cancel-salida').addEventListener('click', () => closeModal('salida-modal'));

document.getElementById('btn-save-salida').addEventListener('click', async () => {
  const concepto = document.getElementById('salida-concepto').value.trim();
  const monto = document.getElementById('salida-monto').value;
  const metodo_pago = document.getElementById('salida-metodo').value;
  const categoria_costo = document.getElementById('salida-categoria').value;

  if (!concepto || !monto || Number(monto) <= 0) {
    toast('Concepto y monto son obligatorios.', 'error');
    return;
  }

  try {
    await window.corteAPI.addMovimiento({
      fecha: currentFecha,
      concepto,
      monto: Number(monto),
      metodo_pago,
      categoria_costo
    });
    toast('Salida registrada.', 'success');
    closeModal('salida-modal');
    loadCorte();
  } catch (err) {
    toast('No se pudo registrar la salida.', 'error');
  }
});

document.getElementById('btn-cerrar-corte').addEventListener('click', async () => {
  const efectivoReal = document.getElementById('efectivo-real-input').value;
  if (efectivoReal === '') {
    toast('Captura el efectivo real contado antes de cerrar.', 'error');
    return;
  }
  if (!confirm('¿Cerrar el corte de caja de hoy? Podrás seguir viéndolo, pero no se podrá editar.')) return;

  try {
    await window.corteAPI.cerrar(currentFecha, Number(efectivoReal));
    toast('Corte de caja cerrado.', 'success');
    loadCorte();
  } catch (err) {
    console.error('No se pudo cerrar el corte:', err);
    toast(err.message || 'No se pudo cerrar el corte.', 'error');
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  await guardPermission('corte', 'can_view');
  const fechaInput = document.getElementById('corte-fecha');
  fechaInput.value = todayISO();
  fechaInput.max = todayISO();
  loadCorte();
  document.getElementById('btnImprimirCorte')?.addEventListener('click', () => imprimirTicketCorte());
});