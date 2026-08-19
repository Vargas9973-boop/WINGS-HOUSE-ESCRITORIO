const PAYROLL_DAY_NAMES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

async function loadSettings() {
  const settings = await window.db.settings.getAll();
  document.getElementById('set-business-name').value = settings.business_name || '';
  document.getElementById('set-business-address').value = settings.business_address || '';
  document.getElementById('set-business-phone').value = settings.business_phone || '';
  document.getElementById('set-employee-discount').value = settings.employee_discount_pct || '15';
  document.getElementById('set-table-count').value = settings.table_count || '10';
  document.getElementById('set-ticket-width').value = settings.ticket_width || '58';
  // Fallback a habilitado: una instalación existente sin este ajuste guardado
  // debe seguir imprimiendo igual que antes de que existiera el toggle.
  document.getElementById('set-printer-enabled').checked = settings.printer_enabled !== 'false';

  let paydayNumber = 6;
  if (settings.payroll_payday) {
    try {
      const parsed = JSON.parse(settings.payroll_payday);
      if (Number.isInteger(parsed.day_number)) paydayNumber = parsed.day_number;
    } catch {
      // valor legado/corrupto: se deja el default (sábado)
    }
  }
  document.getElementById('set-payroll-payday').value = String(paydayNumber);

  await loadPrinters(settings.printer_name || '');

  let biometric = { enabled: false, model: 'u_are_u_4500' };
  if (settings.biometric_enabled) {
    try {
      const parsed = JSON.parse(settings.biometric_enabled);
      biometric.enabled = !!parsed.enabled;
      if (parsed.model) biometric.model = parsed.model;
    } catch {
      // valor legado/corrupto: se deja el default (deshabilitado)
    }
  }
  document.getElementById('set-biometric-enabled').checked = biometric.enabled;
  document.getElementById('set-biometric-model').value = biometric.model;

  loadAlertPrefs();
}

// ==========================================================================
// BIOMETRÍA — lector de huella opcional (Asistencia). "Probar conexión" solo
// sondea el hardware por HID; no depende de que el toggle esté guardado.
// ==========================================================================
document.getElementById('btn-test-biometric').addEventListener('click', async () => {
  const model = document.getElementById('set-biometric-model').value;
  const resultEl = document.getElementById('biometric-test-result');
  resultEl.className = 'status-indicator';
  resultEl.textContent = 'Probando...';
  try {
    const result = await window.biometricAPI.scan(model);
    if (result && result.connected) {
      resultEl.className = 'status-indicator connected';
      resultEl.textContent = `● Lector detectado${result.deviceInfo?.product ? ` (${result.deviceInfo.product})` : ''}.`;
    } else {
      resultEl.className = 'status-indicator disconnected';
      resultEl.textContent = '○ No se detectó el lector. El sistema sigue en registro manual.';
    }
  } catch (err) {
    resultEl.className = 'status-indicator error';
    resultEl.textContent = 'No se pudo probar la conexión.';
  }
});

// ==========================================================================
// ALERTA DE SONIDO — preferencia local (localStorage), no viaja a Supabase:
// cada computadora/estación decide su propio volumen y si suena o no.
// ==========================================================================
const ALERT_MUTE_KEY = 'wh_order_alert_muted';
const ALERT_VOLUME_KEY = 'wh_order_alert_volume';

function loadAlertPrefs() {
  const muted = localStorage.getItem(ALERT_MUTE_KEY) === '1';
  const rawVolume = Number(localStorage.getItem(ALERT_VOLUME_KEY));
  const volumePct = Number.isFinite(rawVolume) && rawVolume >= 0 && rawVolume <= 1
    ? Math.round(rawVolume * 100)
    : 100;

  document.getElementById('set-alert-enabled').checked = !muted;
  document.getElementById('set-alert-volume').value = volumePct;
  document.getElementById('set-alert-volume-value').textContent = volumePct;
}

document.getElementById('set-alert-volume').addEventListener('input', (e) => {
  document.getElementById('set-alert-volume-value').textContent = e.target.value;
});

async function loadPrinters(selected) {
  const select = document.getElementById('set-printer-name');
  select.innerHTML = `<option value="">Preguntar cada vez (mostrar diálogo)</option>`;
  try {
    const printers = await window.printerAPI.list();
    printers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = `${p.displayName || p.name}${p.isDefault ? ' (predeterminada)' : ''}`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error(err);
  }
  select.value = selected;
}

document.getElementById('btn-refresh-printers').addEventListener('click', () => loadPrinters(document.getElementById('set-printer-name').value));

// Imprime de inmediato con la impresora/ancho seleccionados en pantalla
// (aunque todavía no se hayan guardado), guardándolos primero, para que la
// prueba siempre refleje lo que el usuario está a punto de guardar.
document.getElementById('btn-print-test').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  try {
    await window.db.settings.set('printer_name', document.getElementById('set-printer-name').value);
    await window.db.settings.set('ticket_width', document.getElementById('set-ticket-width').value);

    const result = await window.printerAPI.test();

    if (result && result.success) {
      toast('Ticket de prueba enviado a imprimir.', 'success');
    } else if (result && result.reason === 'cancelled') {
      // Usuario cerró el diálogo de impresión sin imprimir: no es un error.
    } else {
      toast('No se pudo imprimir el ticket de prueba.', 'error');
    }
  } catch (err) {
    console.error(err);
    toast('No se pudo imprimir el ticket de prueba.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const paydayNumber = Number(document.getElementById('set-payroll-payday').value);

  const entries = {
    business_name: document.getElementById('set-business-name').value.trim() || 'Wings House',
    business_address: document.getElementById('set-business-address').value.trim(),
    business_phone: document.getElementById('set-business-phone').value.trim(),
    employee_discount_pct: document.getElementById('set-employee-discount').value || '15',
    table_count: document.getElementById('set-table-count').value || '10',
    printer_name: document.getElementById('set-printer-name').value,
    ticket_width: document.getElementById('set-ticket-width').value,
    printer_enabled: document.getElementById('set-printer-enabled').checked ? 'true' : 'false',
    payroll_payday: JSON.stringify({ day: PAYROLL_DAY_NAMES[paydayNumber], day_number: paydayNumber }),
    biometric_enabled: JSON.stringify({
      enabled: document.getElementById('set-biometric-enabled').checked,
      model: document.getElementById('set-biometric-model').value
    })
  };

  try {
    for (const [key, value] of Object.entries(entries)) {
      await window.db.settings.set(key, value);
    }

    const enabled = document.getElementById('set-alert-enabled').checked;
    const volumePct = Number(document.getElementById('set-alert-volume').value) || 0;
    localStorage.setItem(ALERT_MUTE_KEY, enabled ? '0' : '1');
    localStorage.setItem(ALERT_VOLUME_KEY, String(volumePct / 100));

    toast('Ajustes guardados correctamente.', 'success');
  } catch (err) {
    toast('No se pudieron guardar los ajustes.', 'error');
  }
});

// ==========================================================================
// LIQUIDACIÓN DE REPARTIDORES — dinero que ya cobraron en la puerta del
// cliente (payment_status = 'dinero_con_repartidor') y todavía no regresan
// al local. Ver migración 20260819050000_delivery_payment_flow.sql: el
// corte de caja (corte-renderer.js) excluye este dinero hasta que se
// liquida aquí.
// ==========================================================================
async function loadDriversLiquidation() {
  const tbody = document.getElementById('drivers-liquidation-tbody');
  if (!tbody) return;
  try {
    const pending = await window.driversAPI.getPendingMoney();
    if (!pending || pending.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">Sin dinero pendiente de repartidores.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = pending
      .map(
        (d) => `
      <tr>
        <td>${escapeHtmlSettings(d.driverName)}</td>
        <td>${d.pedidos}</td>
        <td>${fmtMoneySettings(d.aRegresar)}</td>
        <td><button class="btn btn-brand btn-sm" data-liquidate="${d.driverId}" data-name="${escapeHtmlSettings(d.driverName)}" data-total="${d.aRegresar}">Liquidar todo</button></td>
      </tr>`
      )
      .join('');

    tbody.querySelectorAll('[data-liquidate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const driverId = btn.dataset.liquidate;
        const name = btn.dataset.name;
        const total = Number(btn.dataset.total) || 0;
        if (!confirm(`¿Recibiste ${fmtMoneySettings(total)} de ${name}?`)) return;
        btn.disabled = true;
        try {
          const result = await window.driversAPI.liquidate(driverId);
          toast(`Liquidado: ${fmtMoneySettings(result.total)} de ${name}.`, 'success');
          await loadDriversLiquidation();
        } catch (err) {
          console.error('No se pudo liquidar al repartidor:', err);
          toast(err && err.message ? err.message : 'No se pudo liquidar al repartidor.', 'error');
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    console.error('No se pudo cargar la liquidación de repartidores:', err);
    tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">No se pudo cargar.</div></td></tr>`;
  }
}

function escapeHtmlSettings(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtMoneySettings(value) {
  const n = Number(value) || 0;
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

document.getElementById('btn-add-driver')?.addEventListener('click', async () => {
  const name = document.getElementById('new-driver-name').value.trim();
  const phone = document.getElementById('new-driver-phone').value.trim();
  if (!name) {
    toast('El nombre del repartidor es obligatorio.', 'error');
    return;
  }
  try {
    await window.driversAPI.create(name, phone || null);
    document.getElementById('new-driver-name').value = '';
    document.getElementById('new-driver-phone').value = '';
    toast('Repartidor agregado.', 'success');
    await loadDriversLiquidation();
  } catch (err) {
    console.error('No se pudo agregar el repartidor:', err);
    toast('No se pudo agregar el repartidor.', 'error');
  }
});

document.addEventListener('DOMContentLoaded', () => {
  guardSession(['admin']);
  loadSettings();
  loadDriversLiquidation();
});
