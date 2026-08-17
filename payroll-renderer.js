// payroll-renderer.js — Módulo "Nómina": semana laboral configurable
// (Ajustes → Nómina → Día de pago), créditos de consumo de empleado
// (payroll_deductions), faltas (asistencia) y cierre semanal con snapshot
// en payroll_history.

let paydayNumber = 6;
let currentWeekStart = null;
let currentWeekEnd = null;
let currentRows = [];

const PAYROLL_DAY_LABELS = {
  0: 'Domingo', 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado'
};

function fmtCorto(fechaISO) {
  const d = new Date(`${fechaISO}T00:00:00`);
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
}

function addDays(fechaISO, days) {
  const d = new Date(`${fechaISO}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localISODate(d);
}

function updateWeekLabel() {
  const payLabel = PAYROLL_DAY_LABELS[paydayNumber] || 'Sábado';
  const endDay = new Date(`${currentWeekEnd}T00:00:00`).getDate();
  document.getElementById('payroll-week-label').textContent =
    `Semana: ${fmtCorto(currentWeekStart)} - ${fmtCorto(currentWeekEnd)} (Pago: ${payLabel} ${endDay})`;
}

async function loadWeek() {
  const tbody = document.getElementById('payroll-tbody');
  tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Cargando...</div></td></tr>`;
  updateWeekLabel();
  try {
    currentRows = await window.db.payroll.getData(currentWeekStart, currentWeekEnd);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No se pudo cargar la nómina de la semana.</div></td></tr>`;
    return;
  }
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('payroll-tbody');
  if (!currentRows || currentRows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">Sin empleados activos.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = currentRows
    .map((r) => {
      const faltasCell = r.sinHistorialAsistencia
        ? '<span title="Este empleado nunca ha registrado asistencia; no se le calculan faltas.">— (sin checador)</span>'
        : String(r.faltas);
      return `<tr>
        <td>${escapeHtmlPayroll(r.employeeName)}</td>
        <td>${fmtMoney(r.sueldoBase)}</td>
        <td>${fmtMoney(r.creditos)} ${r.creditosCount ? `(${r.creditosCount} venta${r.creditosCount === 1 ? '' : 's'})` : ''}</td>
        <td>${faltasCell}</td>
        <td>-${fmtMoney(r.deduccionFaltas)}</td>
        <td>${fmtMoney(r.beneficioUsado)} usado</td>
        <td><strong>${fmtMoney(r.totalAPagar)}</strong></td>
        <td><button class="btn btn-outline btn-sm" data-detalle="${escapeHtmlPayroll(r.employeeName)}">Ver detalle</button></td>
      </tr>`;
    })
    .join('');

  tbody.querySelectorAll('[data-detalle]').forEach((b) =>
    b.addEventListener('click', () => openDetail(b.dataset.detalle))
  );
}

function escapeHtmlPayroll(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function openDetail(employeeName) {
  document.getElementById('payroll-detail-title').textContent = `Detalle — ${employeeName}`;
  const creditosTbody = document.getElementById('payroll-detail-creditos-tbody');
  const faltasDiv = document.getElementById('payroll-detail-faltas');
  creditosTbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Cargando...</div></td></tr>`;
  faltasDiv.innerHTML = '';
  openModal('payroll-detail-modal');

  try {
    const detalle = await window.db.payroll.getDetail(employeeName, currentWeekStart, currentWeekEnd);

    if (!detalle.creditos || detalle.creditos.length === 0) {
      creditosTbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Sin créditos esta semana.</div></td></tr>`;
    } else {
      creditosTbody.innerHTML = detalle.creditos
        .map((c) => {
          const fecha = new Date(c.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
          return `<tr><td>${fecha}</td><td>${escapeHtmlPayroll(c.reason || '')}</td><td>${fmtMoney(c.amount)}</td></tr>`;
        })
        .join('');
    }

    if (!detalle.faltasDias || detalle.faltasDias.length === 0) {
      faltasDiv.innerHTML = `<div class="empty-state">Sin faltas esta semana.</div>`;
    } else {
      faltasDiv.innerHTML = detalle.faltasDias
        .map((f) => `<span class="payroll-faltas-day">${fmtCorto(f)}</span>`)
        .join('');
    }
  } catch (err) {
    creditosTbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">No se pudo cargar el detalle.</div></td></tr>`;
  }
}

document.getElementById('btn-close-detail').addEventListener('click', () => closeModal('payroll-detail-modal'));

document.getElementById('btn-prev-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  currentWeekEnd = addDays(currentWeekEnd, -7);
  loadWeek();
});

document.getElementById('btn-next-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  currentWeekEnd = addDays(currentWeekEnd, 7);
  loadWeek();
});

document.getElementById('btn-cerrar-nomina').addEventListener('click', async () => {
  if (!confirm(`¿Cerrar la nómina de la semana ${fmtCorto(currentWeekStart)} - ${fmtCorto(currentWeekEnd)}? Los créditos de esta semana pasarán a "descontado" y no se podrán volver a incluir.`)) return;

  const btn = document.getElementById('btn-cerrar-nomina');
  btn.disabled = true;
  try {
    await window.db.payroll.close(currentWeekStart, currentWeekEnd);
    toast('Nómina cerrada y guardada en el historial.', 'success');
    loadWeek();
  } catch (err) {
    toast(err.message || 'No se pudo cerrar la nómina.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardSession(['admin']);
  if (!session) return;

  try {
    const settings = await window.db.payroll.getSettings();
    paydayNumber = settings.dayNumber;
  } catch (err) {
    paydayNumber = 6;
  }

  try {
    const range = await window.db.payroll.getWeekRange(paydayNumber);
    currentWeekStart = range.start;
    currentWeekEnd = range.end;
  } catch (err) {
    toast('No se pudo calcular la semana laboral.', 'error');
    return;
  }

  loadWeek();
});
