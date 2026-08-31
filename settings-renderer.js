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

  // No todos los negocios cuentan 6 días laborales (uno de descanso) --
  // algunos cuentan los 7 días de la semana, así que el divisor de la
  // deducción por falta (sueldo / días laborales) no puede ser fijo.
  let workDaysPerWeek = 6;
  const parsedWorkDays = Number(settings.payroll_work_days_per_week);
  if (parsedWorkDays === 6 || parsedWorkDays === 7) workDaysPerWeek = parsedWorkDays;
  document.getElementById('set-payroll-work-days').value = String(workDaysPerWeek);

  if (settings.logo_url) {
    document.getElementById('set-logo-preview').src = settings.logo_url;
  }
  document.getElementById('set-theme-auto').checked = settings.theme_auto === 'true';
  if (settings.theme_colors) {
    try {
      renderThemePreview(JSON.parse(settings.theme_colors));
    } catch {
      // valor corrupto: sin preview, no rompe el resto del formulario
    }
  }

  document.getElementById('set-benefit-enabled').checked = settings.benefit_enabled !== 'false';
  document.getElementById('set-benefit-amount').value = Number(settings.benefit_daily_amount) > 0 ? settings.benefit_daily_amount : '100';
  document.getElementById('set-benefit-counts-as-sale').checked = settings.benefit_counts_as_sale === 'true';
  document.getElementById('set-weekly-credit-enabled').checked = settings.weekly_credit_enabled !== 'false';
  document.getElementById('set-weekly-credit-limit').value = Number(settings.weekly_credit_limit) > 0 ? settings.weekly_credit_limit : '500';

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
// DIAGNÓSTICO — dispara un error real en el proceso principal (sentry:test,
// ver main.js/preload.js) para verificar que llega a sentry.io/issues/.
// ==========================================================================
document.getElementById('btn-test-sentry').addEventListener('click', async () => {
  const resultEl = document.getElementById('sentry-test-result');
  resultEl.className = 'status-indicator';
  resultEl.textContent = 'Enviando...';
  try {
    await window.sentryAPI.triggerTestError();
    // No debería llegar aquí: el canal siempre lanza WINGS TEST ERROR.
    resultEl.className = 'status-indicator connected';
    resultEl.textContent = '● Enviado.';
  } catch (err) {
    resultEl.className = 'status-indicator connected';
    resultEl.textContent = '● Error de prueba enviado a Sentry (WINGS TEST ERROR).';
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

// ==========================================================================
// MARCA / LOGO -- sube a Supabase Storage (bucket "logos") y guarda la URL
// pública en settings.logo_url (key-value normal, no hay columnas nuevas
// en la tabla). Si "theme_auto" está marcado, extrae 2 colores dominantes
// de la imagen con un <canvas> oculto (sin librería externa) y los aplica
// de inmediato a --brand-orange/--brand-red (ver loadAndApplyBranding en
// common.js) además de guardarlos.
// ==========================================================================
let pendingThemeColors = null; // { primary, secondary } del último logo subido/analizado

// Reduce la imagen a un canvas chico y cuenta qué color (cuantizado a
// bloques de 32 por canal, para agrupar tonos parecidos) aparece más veces.
// Los 2 colores más frecuentes que además se distinguen entre sí (no dos
// tonos casi iguales) se toman como primario/secundario. Ignora píxeles
// casi blancos/negros/transparentes (suelen ser fondo, no la marca).
function extractDominantColors(img) {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);

  let pixels;
  try {
    pixels = ctx.getImageData(0, 0, size, size).data;
  } catch (err) {
    console.error('No se pudo leer los píxeles del logo (canvas tainted):', err);
    return null;
  }

  const counts = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a < 128) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max > 235 && min > 220) continue; // casi blanco
    if (max < 25) continue; // casi negro
    const key = [Math.round(r / 32), Math.round(g / 32), Math.round(b / 32)].join(',');
    const entry = counts.get(key) || { r: 0, g: 0, b: 0, count: 0 };
    entry.r += r;
    entry.g += g;
    entry.b += b;
    entry.count += 1;
    counts.set(key, entry);
  }

  const sorted = [...counts.values()]
    .map((e) => ({ r: Math.round(e.r / e.count), g: Math.round(e.g / e.count), b: Math.round(e.b / e.count), count: e.count }))
    .sort((a, b) => b.count - a.count);

  if (sorted.length === 0) return null;

  const toHex = (c) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  const colorDistance = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);

  const primary = sorted[0];
  // El secundario es el siguiente color suficientemente distinto del
  // primario -- si no hay ninguno (logo prácticamente monocromo), se repite
  // el mismo tono.
  const secondary = sorted.find((c) => colorDistance(c, primary) > 60) || primary;

  return { primary: toHex(primary), secondary: toHex(secondary) };
}

function renderThemePreview(colors) {
  const el = document.getElementById('set-theme-preview');
  if (!el) return;
  if (!colors) {
    el.innerHTML = '';
    return;
  }
  const swatch = (hex) => `<span style="display:inline-block; width:18px; height:18px; border-radius:4px; background:${hex}; border:1px solid var(--border-color);" title="${hex}"></span>`;
  el.innerHTML = swatch(colors.primary) + swatch(colors.secondary);
}

document.getElementById('set-logo-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('set-logo-status');
  const preview = document.getElementById('set-logo-preview');
  statusEl.textContent = 'Subiendo logo...';

  try {
    // Preview + extracción de color instantáneos con un data URL local,
    // sin esperar la subida a Storage.
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataUrl;
    });

    preview.src = dataUrl;

    if (document.getElementById('set-theme-auto').checked) {
      pendingThemeColors = extractDominantColors(img);
      renderThemePreview(pendingThemeColors);
      if (pendingThemeColors) {
        document.documentElement.style.setProperty('--brand-orange', pendingThemeColors.primary);
        document.documentElement.style.setProperty('--brand-red', pendingThemeColors.secondary);
      }
    }

    const filePath = window.db.settings.getFilePath(file);
    const result = await window.db.settings.uploadLogo(filePath, file.name);
    preview.src = result.logoUrl;
    statusEl.textContent = 'Logo actualizado.';
    toast('Logo actualizado.', 'success');
    if (window.loadAndApplyBranding) window.loadAndApplyBranding();
    window.db.settings.refreshBranding().catch((err) => console.error('No se pudo refrescar el branding del KDS:', err.message));
  } catch (err) {
    console.error('No se pudo subir el logo:', err);
    statusEl.textContent = 'No se pudo subir el logo.';
    toast('No se pudo subir el logo.', 'error');
  }
});

document.getElementById('set-theme-auto').addEventListener('change', (e) => {
  if (e.target.checked) {
    // Si ya hay un logo cargado en el preview, extrae colores de una vez en
    // vez de esperar a que se suba uno nuevo.
    const preview = document.getElementById('set-logo-preview');
    if (preview && preview.complete && preview.naturalWidth > 0) {
      pendingThemeColors = extractDominantColors(preview);
      renderThemePreview(pendingThemeColors);
      if (pendingThemeColors) {
        document.documentElement.style.setProperty('--brand-orange', pendingThemeColors.primary);
        document.documentElement.style.setProperty('--brand-red', pendingThemeColors.secondary);
      }
    }
  } else {
    pendingThemeColors = null;
    renderThemePreview(null);
    restoreDefaultTheme();
  }
});

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

  // Number(value) > 0, no solo "!value" (ver mismo fix en catalog-renderer.js):
  // un "0" tecleado literal es un string no vacío y pasaría una validación
  // que solo revisara `!value`.
  const benefitAmountRaw = document.getElementById('set-benefit-amount').value;
  const weeklyLimitRaw = document.getElementById('set-weekly-credit-limit').value;
  if (!(Number(benefitAmountRaw) > 0)) {
    toast('La cantidad diaria del beneficio debe ser mayor a $0.', 'error');
    return;
  }
  if (!(Number(weeklyLimitRaw) > 0)) {
    toast('El tope de crédito semanal debe ser mayor a $0.', 'error');
    return;
  }

  const themeAuto = document.getElementById('set-theme-auto').checked;

  const entries = {
    business_name: document.getElementById('set-business-name').value.trim() || 'KATSAM Sistema de gestión para restaurantes',
    business_address: document.getElementById('set-business-address').value.trim(),
    business_phone: document.getElementById('set-business-phone').value.trim(),
    employee_discount_pct: document.getElementById('set-employee-discount').value || '15',
    table_count: document.getElementById('set-table-count').value || '10',
    printer_name: document.getElementById('set-printer-name').value,
    ticket_width: document.getElementById('set-ticket-width').value,
    printer_enabled: document.getElementById('set-printer-enabled').checked ? 'true' : 'false',
    payroll_payday: JSON.stringify({ day: PAYROLL_DAY_NAMES[paydayNumber], day_number: paydayNumber }),
    payroll_work_days_per_week: document.getElementById('set-payroll-work-days').value === '7' ? '7' : '6',
    biometric_enabled: JSON.stringify({
      enabled: document.getElementById('set-biometric-enabled').checked,
      model: document.getElementById('set-biometric-model').value
    }),
    theme_auto: themeAuto ? 'true' : 'false',
    benefit_enabled: document.getElementById('set-benefit-enabled').checked ? 'true' : 'false',
    benefit_daily_amount: benefitAmountRaw,
    benefit_counts_as_sale: document.getElementById('set-benefit-counts-as-sale').checked ? 'true' : 'false',
    weekly_credit_enabled: document.getElementById('set-weekly-credit-enabled').checked ? 'true' : 'false',
    weekly_credit_limit: weeklyLimitRaw
  };

  // theme_colors solo se guarda si theme_auto está activo y ya se extrajeron
  // colores de un logo (subido en esta sesión o ya guardado antes); si se
  // desactiva, se deja de mandar (loadAndApplyBranding ya restaura el
  // default cuando theme_auto='false', sin necesitar borrar el valor viejo).
  if (themeAuto && pendingThemeColors) {
    entries.theme_colors = JSON.stringify(pendingThemeColors);
  }

  try {
    for (const [key, value] of Object.entries(entries)) {
      await window.db.settings.set(key, value);
    }

    const enabled = document.getElementById('set-alert-enabled').checked;
    const volumePct = Number(document.getElementById('set-alert-volume').value) || 0;
    localStorage.setItem(ALERT_MUTE_KEY, enabled ? '0' : '1');
    localStorage.setItem(ALERT_VOLUME_KEY, String(volumePct / 100));

    if (!themeAuto) restoreDefaultTheme();
    if (window.loadAndApplyBranding) await window.loadAndApplyBranding();
    window.db.settings.refreshBranding().catch((err) => console.error('No se pudo refrescar el branding del KDS:', err.message));

    toast('Ajustes aplicados.', 'success');
  } catch (err) {
    console.error('No se pudieron guardar los ajustes:', err);
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

// ==========================================================================
// MANTENIMIENTO DEL SISTEMA — versión/última comprobación/actualización son
// LOCALES a esta instalación (ver update-status.json en main.js), nunca se
// guardan en `settings` (esa tabla es dato de negocio por sucursal/tenant).
// "Estado" reutiliza window.db.settings.getAll(), ya scoped por sucursal
// igual que loadSettings() de arriba; "Conexión" reutiliza orderAlertAPI,
// el mismo canal que ya usa la alerta de comandas nuevas (order-alert.js).
// ==========================================================================
function fmtLastCheck(iso) {
  if (!iso) return 'Nunca';
  const d = new Date(iso);
  const time = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `Hoy ${time}` : `${d.toLocaleDateString('es-MX')} ${time}`;
}

function renderMaintInfo(info) {
  if (info.version) document.getElementById('maint-version').textContent = info.version;
  document.getElementById('maint-last-check').textContent = fmtLastCheck(info.lastCheckedAt);
}

function renderConnection(connected) {
  const el = document.getElementById('maint-connection');
  el.className = connected ? 'status-indicator connected' : 'status-indicator disconnected';
  el.textContent = connected ? '● Conectado' : '○ Sin conexión en vivo';
}

async function loadMaintenancePanel() {
  const statusEl = document.getElementById('maint-status');
  try {
    await window.db.settings.getAll();
    statusEl.className = 'status-indicator connected';
    statusEl.textContent = '● Operativo';
  } catch (err) {
    statusEl.className = 'status-indicator error';
    statusEl.textContent = '● Con problemas';
  }

  try {
    renderMaintInfo(await window.systemAPI.getInfo());
  } catch (err) {
    console.error('No se pudo leer la información del sistema:', err);
  }

  try {
    renderConnection(await window.orderAlertAPI.getStatus());
  } catch (err) {
    renderConnection(false);
  }
}

window.systemAPI.onUpdateStatus((status) => renderMaintInfo(status));
window.orderAlertAPI.onStatus((connected) => renderConnection(connected));

document.getElementById('btn-check-update').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Buscando...';
  try {
    const info = await window.systemAPI.checkForUpdate();
    renderMaintInfo(info);
    if (info.checkError) {
      toast('No se pudo comprobar actualizaciones (revisa tu conexión).', 'error');
    } else if (info.updateAvailable) {
      toast(`Hay una actualización disponible (${info.latestVersion}).`, 'default');
    } else {
      toast('Ya tienes la última versión.', 'success');
    }
  } catch (err) {
    console.error('No se pudo buscar actualizaciones:', err);
    toast('No se pudo comprobar actualizaciones.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Buscar actualización';
  }
});

document.getElementById('btn-run-diagnostics').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  const resultsEl = document.getElementById('diagnostics-results');
  resultsEl.textContent = 'Ejecutando...';
  openModal('diagnostics-modal');
  try {
    const { checks } = await window.systemAPI.runDiagnostics();
    resultsEl.innerHTML = '';
    checks.forEach((c) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; justify-content:space-between; gap:10px; align-items:center;';
      const label = document.createElement('span');
      label.textContent = c.name;
      const value = document.createElement('span');
      value.className = `status-indicator ${c.ok ? 'connected' : 'error'}`;
      value.textContent = `● ${c.detail}`;
      row.appendChild(label);
      row.appendChild(value);
      resultsEl.appendChild(row);
    });
  } catch (err) {
    console.error('No se pudo ejecutar el diagnóstico:', err);
    resultsEl.textContent = 'No se pudo ejecutar el diagnóstico.';
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('btn-close-diagnostics').addEventListener('click', () => closeModal('diagnostics-modal'));

document.getElementById('btn-report-problem').addEventListener('click', () => {
  document.getElementById('report-problem-description').value = '';
  openModal('report-problem-modal');
});
document.getElementById('btn-cancel-report').addEventListener('click', () => closeModal('report-problem-modal'));
document.getElementById('btn-send-report').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  const description = document.getElementById('report-problem-description').value.trim();
  if (!description) {
    toast('Escribe una descripción del problema.', 'error');
    return;
  }
  btn.disabled = true;
  try {
    await window.systemAPI.reportProblem(description);
    toast('Reporte enviado. Gracias.', 'success');
    closeModal('report-problem-modal');
  } catch (err) {
    console.error('No se pudo enviar el reporte:', err);
    toast(err.message || 'No se pudo enviar el reporte.', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.addEventListener('DOMContentLoaded', () => {
  guardPermission('ajustes', 'can_view');
  loadSettings();
  loadDriversLiquidation();
  loadMaintenancePanel();
});
