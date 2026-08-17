const PAYROLL_DAY_NAMES = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

async function loadSettings() {
  const settings = await window.db.settings.getAll();
  document.getElementById('set-business-name').value = settings.business_name || '';
  document.getElementById('set-business-address').value = settings.business_address || '';
  document.getElementById('set-business-phone').value = settings.business_phone || '';
  document.getElementById('set-employee-discount').value = settings.employee_discount_pct || '15';
  document.getElementById('set-table-count').value = settings.table_count || '10';
  document.getElementById('set-ticket-width').value = settings.ticket_width || '58';

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

  loadAlertPrefs();
}

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
    payroll_payday: JSON.stringify({ day: PAYROLL_DAY_NAMES[paydayNumber], day_number: paydayNumber })
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

document.addEventListener('DOMContentLoaded', () => {
  guardSession(['admin']);
  loadSettings();
});
