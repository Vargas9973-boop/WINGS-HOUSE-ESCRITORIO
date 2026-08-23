// Utilidades compartidas por todos los módulos administrativos.

function goHome() {
  if (window.api && window.api.sendAction) {
    window.api.sendAction('open-menu');
  } else {
    window.location.href = 'index.html';
  }
}

function goTo(action) {
  if (window.api && window.api.sendAction) {
    window.api.sendAction(action);
  }
}

// Fecha de HOY en horario LOCAL, formato YYYY-MM-DD.
// IMPORTANTE: nunca usar `new Date().toISOString().slice(0,10)` para esto,
// porque toISOString() devuelve la fecha en UTC. En México (UTC-6), a partir
// de las 18:00 hora local el reloj UTC ya marca el día siguiente, así que
// ese patrón hacía que los filtros "Hoy" (Reportes, Costos, Asistencia)
// dejaran de mostrar las ventas/mermas/cambios registrados esa misma tarde-
// noche: se estaba consultando por el día de mañana. localISODate() arma la
// fecha con los componentes locales del objeto Date, sin pasar por UTC.
function localISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function fmtMoney(value) {
  const n = Number(value) || 0;
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value.replace(' ', 'T'));
  if (isNaN(d.getTime())) return value;
  return d.toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function toast(message, type = 'default') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 0.3s ease';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

function openModal(id) {
  document.getElementById(id)?.classList.add('show');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

// ==========================================================================
// LOGO / TEMA DE COLORES (Ajustes -> SaaS) -- settings.logo_url y
// settings.theme_colors (JSON {primary, secondary}, solo si theme_auto)
// se guardan como key-value normal, igual que cualquier otro ajuste; no hay
// columnas nuevas en la tabla. Se cachea en localStorage para que el logo/
// color aparezcan al instante (antes de que responda Supabase) y para que
// la app siga viéndose igual sin conexión -- ver localDayStartUtcIso() en
// db.js para el mismo motivo aplicado a fechas, no a branding.
const BRAND_CACHE_KEY = 'wh_branding_cache';

function applyBrandingValues(values) {
  if (!values) return;
  if (values.logoUrl) {
    document.querySelectorAll('.header-logo, .header-mini-logo, .login-logo, .modal-logo, .ticket-logo, #app-logo').forEach((img) => {
      img.src = values.logoUrl;
    });
  }
  if (values.companyName) {
    document.querySelectorAll('.brand-name').forEach((el) => {
      el.textContent = values.companyName;
    });
  }
  if (values.primaryColor) document.documentElement.style.setProperty('--brand-orange', values.primaryColor);
  if (values.secondaryColor) document.documentElement.style.setProperty('--brand-red', values.secondaryColor);
}

// Quita el override inline: la hoja de estilos vuelve a mandar con sus
// valores originales (--brand-orange/--brand-red default de common.css).
function restoreDefaultTheme() {
  document.documentElement.style.removeProperty('--brand-orange');
  document.documentElement.style.removeProperty('--brand-red');
}

// Expuesta en window para que settings-renderer.js la vuelva a llamar justo
// después de guardar, y así se vea el cambio sin F5.
async function loadAndApplyBranding() {
  try {
    const cached = JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) || 'null');
    if (cached) applyBrandingValues(cached);
  } catch {
    // caché corrupta/ausente: sigue con los defaults hasta que responda Supabase
  }

  if (!window.db || !window.db.settings) return;
  try {
    const settings = await window.db.settings.getAll();
    const themeAuto = settings.theme_auto === 'true';
    let primaryColor = null;
    let secondaryColor = null;
    if (themeAuto && settings.theme_colors) {
      try {
        const parsed = JSON.parse(settings.theme_colors);
        primaryColor = parsed.primary || null;
        secondaryColor = parsed.secondary || null;
      } catch {
        // valor corrupto: se ignora, se queda en el color default
      }
    }
    if (!themeAuto) restoreDefaultTheme();
    const values = {
      logoUrl: settings.logo_url || null,
      companyName: settings.business_name || 'Wings House',
      primaryColor,
      secondaryColor
    };
    applyBrandingValues(values);
    localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify(values));
    if (values.companyName) document.title = document.title.replace(/Wings House/, values.companyName);
  } catch (err) {
    console.error('No se pudo cargar el logo/tema del negocio:', err);
  }
}
window.loadAndApplyBranding = loadAndApplyBranding;

document.addEventListener('DOMContentLoaded', () => {
  loadAndApplyBranding();

  document.querySelectorAll('[data-nav-home]').forEach((btn) => {
    btn.addEventListener('click', goHome);
  });

  // Botón "⌨️ Atajos (F1)" en el header de cada pantalla, inyectado por JS
  // en vez de tener que agregar el mismo <button> a mano en cada .html
  // (mismo patrón que renderUserBadge, más abajo).
  const header = document.querySelector('.module-header, .sales-header, .app-header');
  if (header && !document.getElementById('btn-shortcuts-help')) {
    const btn = document.createElement('button');
    btn.id = 'btn-shortcuts-help';
    btn.type = 'button';
    btn.className = 'btn-shortcuts-help';
    btn.textContent = '⌨️ Atajos (F1)';
    btn.addEventListener('click', showShortcutsModal);
    header.appendChild(btn);
  }
});

// ==========================================================================
// ATAJOS DE TECLADO -- ver shortcuts.js (fuente de verdad, usada por
// main.js). Esta lista es una copia intencional para el modal de ayuda: un
// renderer no puede require('./shortcuts.js') (nodeIntegration: false,
// contextIsolation: true, sin bundler en este proyecto para compartir un
// módulo de otra forma). Si cambias una descripción allá, cámbiala aquí.
//
// F1-F5/F8/F9 se registran como atajo de SISTEMA en main.js
// (globalShortcut) porque nadie más los usa. Ctrl+P/Ctrl+S/Ctrl+N/Ctrl+K/
// Alt+C/Esc NO: si fueran globales, dejarían de funcionar en cualquier otro
// programa de la misma PC (Excel, el navegador, lo que sea) mientras Wings
// House esté corriendo -- por eso viven aquí, como listener local que solo
// reacciona con esta ventana enfocada, el comportamiento normal de
// cualquier atajo de aplicación.
const SHORTCUTS_HELP = [
  ['F1', 'Ver esta ayuda'],
  ['F2', 'Nueva venta (Comandas)'],
  ['F3', 'Ir a Cocina (ventana KDS)'],
  ['F4', 'Ir a Inventario'],
  ['F5', 'Refrescar la pantalla actual'],
  ['F8', 'Mostrar/ocultar TV de cocina (KDS)'],
  ['F9', 'Corte de caja'],
  ['Ctrl+P', 'Reimprimir el último ticket'],
  ['Ctrl+K', 'Buscar producto (Comandas)'],
  ['Ctrl+N', 'Nueva venta / nuevo insumo, según la pantalla'],
  ['Ctrl+S', 'Guardar el formulario abierto'],
  ['Alt+C', 'Cobrar la venta actual (Comandas)'],
  ['Esc', 'Cerrar el modal abierto / cancelar'],
  ['+ / -', 'Sumar/restar 1 a la cantidad del item seleccionado en Orden Actual'],
  ['Ctrl + / Ctrl -', 'Sumar/restar 10 a la cantidad del item seleccionado'],
  ['0-9 y Enter', 'Teclear una cantidad y Enter la aplica al último producto agregado']
];

function ensureShortcutsModalStyles() {
  if (document.getElementById('shortcuts-modal-styles')) return;
  const style = document.createElement('style');
  style.id = 'shortcuts-modal-styles';
  style.textContent = `
    #shortcuts-modal-overlay {
      position: fixed; inset: 0; z-index: 100000;
      background: rgba(0,0,0,0.6);
      display: flex; align-items: center; justify-content: center;
      opacity: 0; pointer-events: none;
      transition: opacity 0.15s ease;
    }
    #shortcuts-modal-overlay.show { opacity: 1; pointer-events: all; }
    #shortcuts-modal-overlay .shortcuts-modal-box {
      background: #1e1712; color: #f4ede4;
      border: 1px solid #3a2f26; border-radius: 14px;
      padding: 24px 28px; max-width: 640px; width: 92%;
      max-height: 84vh; overflow-y: auto;
      box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    #shortcuts-modal-overlay h2 { margin: 0 0 6px; font-size: 1.3rem; }
    #shortcuts-modal-overlay .shortcuts-tip {
      color: #ffb703; font-size: 0.85rem; margin: 0 0 18px;
    }
    #shortcuts-modal-overlay .shortcuts-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px;
    }
    @media (max-width: 560px) {
      #shortcuts-modal-overlay .shortcuts-grid { grid-template-columns: 1fr; }
    }
    #shortcuts-modal-overlay .shortcuts-grid > div {
      display: flex; align-items: center; gap: 10px; font-size: 0.88rem;
    }
    #shortcuts-modal-overlay kbd {
      display: inline-block; min-width: 28px; text-align: center;
      background: #eee; color: #1a1a1a;
      border: 1px solid #b8b8b8; border-bottom-width: 3px;
      border-radius: 6px; padding: 3px 8px;
      font-family: inherit; font-size: 0.8rem; font-weight: 700;
    }
    #shortcuts-modal-overlay .shortcuts-modal-close {
      margin-top: 22px; width: 100%;
      background: #ff8a00; color: #1a0d00; border: none;
      border-radius: 8px; padding: 10px; font-weight: 700; font-size: 0.9rem;
      cursor: pointer;
    }
    .btn-shortcuts-help {
      background: transparent; border: 1px solid var(--border-color, #3a2f26);
      color: inherit; border-radius: 8px; padding: 6px 12px;
      font-size: 0.8rem; cursor: pointer;
    }
  `;
  document.head.appendChild(style);
}

function buildShortcutsModal() {
  let overlay = document.getElementById('shortcuts-modal-overlay');
  if (overlay) return overlay;
  ensureShortcutsModalStyles();
  overlay = document.createElement('div');
  overlay.id = 'shortcuts-modal-overlay';
  overlay.innerHTML = `
    <div class="shortcuts-modal-box">
      <h2>⌨️ Atajos de teclado</h2>
      <p class="shortcuts-tip">Tip: puedes operar toda la caja solo con teclado.</p>
      <div class="shortcuts-grid">
        ${SHORTCUTS_HELP.map(([key, desc]) => `<div><kbd>${key}</kbd><span>${desc}</span></div>`).join('')}
      </div>
      <button type="button" class="shortcuts-modal-close">Cerrar (Esc)</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeShortcutsModal(); });
  overlay.querySelector('.shortcuts-modal-close').addEventListener('click', closeShortcutsModal);
  return overlay;
}

function showShortcutsModal() {
  buildShortcutsModal().classList.add('show');
}

function closeShortcutsModal() {
  document.getElementById('shortcuts-modal-overlay')?.classList.remove('show');
}

// ==========================================================================
// BUFFER DE CANTIDAD POR TECLADO -- usado en Ventas/Comandas para agregar
// varias unidades de un jalón: teclear "50" y luego hacer clic en un
// producto (o Enter, ver más abajo) agrega/ajusta 50 en vez de 1. El buffer
// expira solo tras QTY_BUFFER_TIMEOUT_MS de inactividad para no quedar
// "pegado" a un número tecleado hace rato por error.
// ==========================================================================
const QTY_BUFFER_TIMEOUT_MS = 1500;
let __qtyBuffer = '';
let __qtyBufferTimer = null;

function qtyBufferIndicatorEl() {
  return document.getElementById('qty-buffer-indicator');
}

function renderQtyBufferIndicator() {
  let el = qtyBufferIndicatorEl();
  if (!__qtyBuffer) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'qty-buffer-indicator';
    document.body.appendChild(el);
  }
  el.textContent = `Cantidad: ${__qtyBuffer} — clic en un producto o Enter`;
}

function qtyBufferPush(digit) {
  clearTimeout(__qtyBufferTimer);
  __qtyBuffer = (__qtyBuffer + digit).slice(-3); // tope natural: máx 999
  __qtyBufferTimer = setTimeout(() => {
    __qtyBuffer = '';
    renderQtyBufferIndicator();
  }, QTY_BUFFER_TIMEOUT_MS);
  renderQtyBufferIndicator();
}

// Lee el buffer sin consumirlo (por si algún día se necesita solo mostrarlo).
function qtyBufferPeek() {
  const n = parseInt(__qtyBuffer, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(999, n) : null;
}

function qtyBufferConsume() {
  const n = qtyBufferPeek();
  __qtyBuffer = '';
  clearTimeout(__qtyBufferTimer);
  renderQtyBufferIndicator();
  return n;
}
window.qtyBufferConsume = qtyBufferConsume;

// ==========================================================================
// TECLADO NUMÉRICO EN PANTALLA PARA CANTIDAD (doble clic en el input de
// cantidad del carrito) -- pensado para pantallas táctiles, donde escribir
// con un teclado de verdad no siempre es cómodo. sales-renderer.js y
// comandas-renderer.js llaman a openQtyKeypad(cantidadActual, callback);
// el callback recibe la cantidad final ya validada (1-999) solo si se
// confirma con OK.
// ==========================================================================
function ensureQtyKeypadModal() {
  let overlay = document.getElementById('qty-keypad-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'qty-keypad-overlay';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-content qty-keypad-box">
      <h3>Cantidad</h3>
      <div id="qty-keypad-display" class="qty-keypad-display">1</div>
      <div class="qty-keypad-grid">
        ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button type="button" class="qty-keypad-key" data-key="${n}">${n}</button>`).join('')}
        <button type="button" class="qty-keypad-key qty-keypad-clear" data-key="C">C</button>
        <button type="button" class="qty-keypad-key" data-key="0">0</button>
        <button type="button" class="qty-keypad-key qty-keypad-ok" data-key="OK">OK</button>
      </div>
      <button type="button" class="qty-keypad-cancel" id="qty-keypad-cancel">Cancelar</button>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeQtyKeypad(); });
  overlay.querySelector('#qty-keypad-cancel').addEventListener('click', closeQtyKeypad);
  overlay.querySelectorAll('.qty-keypad-key').forEach((btn) => {
    btn.addEventListener('click', () => handleQtyKeypadKey(btn.dataset.key));
  });
  return overlay;
}

let __qtyKeypadValue = '';
let __qtyKeypadCallback = null;

function openQtyKeypad(initialQty, onConfirm) {
  ensureQtyKeypadModal();
  __qtyKeypadValue = String(Math.max(1, Math.min(999, Math.floor(Number(initialQty)) || 1)));
  __qtyKeypadCallback = onConfirm;
  document.getElementById('qty-keypad-display').textContent = __qtyKeypadValue;
  document.getElementById('qty-keypad-overlay').classList.add('show');
}
window.openQtyKeypad = openQtyKeypad;

function closeQtyKeypad() {
  document.getElementById('qty-keypad-overlay')?.classList.remove('show');
  __qtyKeypadCallback = null;
}

function handleQtyKeypadKey(key) {
  const display = document.getElementById('qty-keypad-display');
  if (key === 'C') {
    __qtyKeypadValue = '';
  } else if (key === 'OK') {
    const qty = Math.max(1, Math.min(999, parseInt(__qtyKeypadValue, 10) || 1));
    const cb = __qtyKeypadCallback;
    closeQtyKeypad();
    if (cb) cb(qty);
    return;
  } else {
    if (__qtyKeypadValue.length >= 3) return;
    __qtyKeypadValue = __qtyKeypadValue === '0' ? key : __qtyKeypadValue + key;
  }
  display.textContent = __qtyKeypadValue || '0';
}

// ==========================================================================
// GANCHO PARA +/- DE TECLADO SOBRE "ORDEN ACTUAL" -- sales-renderer.js y
// comandas-renderer.js llenan esto con { adjustSelected(delta), applyToLast(qty) }
// una vez que conocen su propio carrito (cart[] local vs currentItems[] del
// servidor). Si la pantalla actual no define el gancho (p.ej. cualquier otro
// módulo que también cargue common.js), las teclas simplemente no hacen nada.
// ==========================================================================
window.__whQtyHooks = window.__whQtyHooks || null;

// Reimprime el último ticket cobrado en ESTA ventana (window.__lastSaleId,
// lo pone comandas-renderer.js/sales-renderer.js al cerrar una venta). No
// hay un concepto de "último ticket" a nivel de app -- es deliberadamente
// por ventana/sesión de uso, no una consulta al historial completo.
async function handleReprintLastTicket() {
  if (!window.printerAPI || typeof window.printerAPI.printTicket !== 'function') return;
  if (!window.__lastSaleId) {
    toast('No hay ningún ticket reciente para reimprimir.', 'error');
    return;
  }
  try {
    await window.printerAPI.printTicket(window.__lastSaleId);
    toast('Reimprimiendo el último ticket...', 'success');
  } catch (err) {
    toast(err && err.message ? err.message : 'No se pudo reimprimir el ticket.', 'error');
  }
}

// Guard de idempotencia: común.js se carga una sola vez por navegación real
// (mainWindow.loadFile descarta el documento anterior por completo), pero
// esto asegura que si algún día un mismo documento vuelve a inyectar este
// script, no se dupliquen los listeners (pedido explícito: "no registrar
// duplicados al navegar").
if (!window.__whShortcutsInit) {
  window.__whShortcutsInit = true;

  window.addEventListener('keydown', (e) => {
    const typing = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA');

    if (e.key === 'F1') {
      // Respaldo local: si por lo que sea el atajo global F1 no se pudo
      // registrar (globalShortcut.register puede fallar en silencio, p.ej.
      // otra app ya lo reclamó), esto sigue funcionando con la ventana
      // enfocada.
      e.preventDefault();
      showShortcutsModal();
      return;
    }

    if (e.key === 'Escape') {
      // data-persistent: modales obligatorios sin botón de cancelar (p.ej.
      // #client-type-modal en sales.html, que exige elegir tipo de cliente
      // antes de continuar) -- Esc no debe dejar la pantalla a medias.
      const openModals = document.querySelectorAll('.modal-overlay.show:not([data-persistent])');
      if (openModals.length > 0) {
        e.preventDefault();
        openModals.forEach((m) => m.classList.remove('show'));
      }
      window.dispatchEvent(new CustomEvent('app-shortcut', { detail: 'Esc' }));
      return;
    }

    // Ctrl+S: SIEMPRE pasa, incluso escribiendo (guardar a media captura es
    // exactamente el caso de uso).
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      const activeModal = document.querySelector('.modal-overlay.show');
      const saveBtn = activeModal && activeModal.querySelector('.btn-brand, .btn-primary');
      if (saveBtn) saveBtn.click();
      window.dispatchEvent(new CustomEvent('app-shortcut', { detail: 'Ctrl+S' }));
      return;
    }

    // +/- de cantidad sobre el item "seleccionado" en Orden Actual (el que
    // tiene el foco en su input de cantidad, o si no hay ninguno, el último
    // agregado -- lo decide el gancho de cada pantalla). A diferencia de los
    // combos de letra de abajo, SÍ deben funcionar con el input de cantidad
    // enfocado (typing=true), que es justo el caso de uso normal.
    const isQtyPlus = e.key === '+' || e.code === 'NumpadAdd';
    const isQtyMinus = e.key === '-' || e.code === 'NumpadSubtract';
    if ((isQtyPlus || isQtyMinus) && window.__whQtyHooks) {
      e.preventDefault();
      const delta = (isQtyPlus ? 1 : -1) * (e.ctrlKey ? 10 : 1);
      window.__whQtyHooks.adjustSelected(delta);
      return;
    }

    // Buffer de cantidad: dígitos tecleados SIN estar escribiendo en ningún
    // input (p.ej. con el catálogo enfocado) se acumulan para "50 + clic en
    // el producto"; Enter con buffer pendiente lo aplica al último producto
    // agregado. Ver qtyBufferPush/qtyBufferConsume más arriba.
    if (!typing && window.__whQtyHooks && /^[0-9]$/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      qtyBufferPush(e.key);
      return;
    }

    if (!typing && e.key === 'Enter' && window.__whQtyHooks) {
      const qty = qtyBufferConsume();
      if (qty != null) {
        e.preventDefault();
        window.__whQtyHooks.applyToLast(qty);
        return;
      }
    }

    // El resto de combos con letra (Ctrl+K/Ctrl+N/Alt+C) se ignoran
    // mientras se está escribiendo en un input/textarea, para no interrumpir
    // -- a diferencia de F2-F9, que son globales y ni siquiera pasan por
    // aquí (main.js no ve el DOM del renderer para saber si hay un input
    // enfocado).
    if (typing) return;

    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('app-shortcut', { detail: 'Ctrl+K' }));
      return;
    }
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('app-shortcut', { detail: 'Ctrl+N' }));
      return;
    }
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      handleReprintLastTicket();
      return;
    }
    if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('app-shortcut', { detail: 'Alt+C' }));
    }
  });

  // F1 (ayuda) y F5 (refrescar) llegan también por IPC desde el atajo
  // global de main.js -- F5 recarga el documento completo, que ya vuelve a
  // correr el propio DOMContentLoaded de cada página (misma lógica de
  // carga de datos que ya existe, sin tener que adivinar el nombre de la
  // función de refresco de cada módulo).
  if (window.api && window.api.onShortcut) {
    window.api.onShortcut((key) => {
      if (key === 'F1') showShortcutsModal();
      else if (key === 'F5') window.location.reload();
    });
  }
}

// ==========================================================================
// SESIÓN Y ROLES
// ==========================================================================
const ROLE_LABELS = { admin: 'Administrador', cajero: 'Cajero', empleado: 'Empleado' };

// Verifica que haya sesión y que el rol esté permitido; si no, redirige.
// allowedRoles=null significa "cualquier usuario con sesión". Sigue
// funcionando igual que siempre (no se quitó) -- guardPermission() de abajo
// es la vía nueva, basada en permisos por módulo en vez de un arreglo fijo
// de nombres de rol.
async function guardSession(allowedRoles = null) {
  const session = await window.auth.getSession();
  if (!session) {
    goTo('open-login');
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    toast('No tienes permiso para acceder a este módulo.', 'error');
    setTimeout(goHome, 900);
    return null;
  }
  __currentSessionCache = session;
  renderUserBadge(session);
  return session;
}

// ==========================================================================
// PERMISOS POR MÓDULO (Cuentas -> Roles) -- login() ya adjunta
// session.permissions (get_user_permissions RPC) y session.role (texto
// legado). __currentSessionCache se llena en guardSession()/guardPermission(),
// así que hasPermission() puede consultarse de forma síncrona después
// (p.ej. desde sidebar/menu para mostrar/ocultar botones) sin volver a
// pedir la sesión a IPC cada vez.
let __currentSessionCache = null;

// role==='admin' (texto legado) siempre pasa, sin importar permissions --
// nunca debe poder quedar fuera de su propia app. Si el usuario no tiene
// role_id todavía (instalación sin migrar, permissions=[]) y no es admin,
// esto deniega -- mismo criterio conservador que guardSession(['admin'])
// ya aplicaba antes de este sistema para cualquiera que no fuera admin.
function hasPermission(moduleName, action = 'can_view') {
  const session = __currentSessionCache;
  if (!session) return false;
  if (session.role === 'admin') return true;
  const perms = session.permissions || [];
  const modPerm = perms.find((p) => p.module === moduleName);
  return !!(modPerm && modPerm[action]);
}

// Reemplazo recomendado de guardSession(['admin', ...]) para pantallas ya
// migradas al sistema de permisos: exige sesión (cualquier rol) y además el
// permiso puntual pedido. A diferencia de guardSession(allowedRoles), esto
// SÍ deja pasar a un rol personalizado (Gerente, Mesero, etc.) si su
// role_permissions lo autoriza, no solo a los 3 roles de texto legado.
async function guardPermission(moduleName, action = 'can_view') {
  const session = await window.auth.getSession();
  if (!session) {
    goTo('open-login');
    return null;
  }
  __currentSessionCache = session;
  if (!hasPermission(moduleName, action)) {
    toast('No tienes permiso para acceder a este módulo.', 'error');
    setTimeout(goHome, 900);
    return null;
  }
  renderUserBadge(session);
  return session;
}

function renderUserBadge(session) {
  const header = document.querySelector('.module-header');
  if (!header || document.getElementById('user-badge')) return;
  const wrap = document.createElement('div');
  wrap.id = 'user-badge';
  wrap.style.cssText = 'display:flex;align-items:center;gap:10px;';
  wrap.innerHTML = `
    <div style="text-align:right; line-height:1.2;">
      <div style="font-size:0.82rem; font-weight:700;">${session.displayName}</div>
      <div style="font-size:0.7rem; color:var(--text-muted);">${ROLE_LABELS[session.role] || session.role}</div>
    </div>
    <button id="btn-logout" class="btn btn-outline btn-sm">Salir</button>
  `;
  header.appendChild(wrap);
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await window.auth.logout();
    goTo('open-login');
  });
}

// ==========================================================================
// CONVERSIÓN DE UNIDADES (masa/volumen) -- ver public.convert_unit() en
// supabase/migrations/20260818030000_unit_conversion.sql, misma tabla.
// ==========================================================================
// La receta de un producto SIEMPRE guarda quantity_needed en la unidad
// propia del insumo (catalog-renderer.js no deja elegir otra), así que hoy
// nada llama a esto todavía -- queda listo por si en el futuro se necesita
// comparar/convertir entre unidades (p.ej. receta capturada en kg contra un
// insumo llevado en g). Unidades no convertibles entre sí (pz/orden/porción,
// o mezclar masa con volumen) regresan null: ahí el llamador debe bloquear
// con un mensaje explícito en vez de adivinar una conversión.
const UNIT_CONVERSIONS = {
  kg: { g: 1000, mg: 1000000 },
  g: { kg: 0.001, mg: 1000 },
  mg: { kg: 0.000001, g: 0.001 },
  L: { ml: 1000 },
  ml: { L: 0.001 }
};

function convertUnit(qty, fromUnit, toUnit) {
  const from = (fromUnit || '').trim();
  const to = (toUnit || '').trim();
  if (from === to) return Number(qty) || 0;
  const factor = (UNIT_CONVERSIONS[from] || {})[to];
  if (factor == null) return null;
  return (Number(qty) || 0) * factor;
}

// ==========================================================================
// DISPONIBILIDAD DE PRODUCTOS SEGÚN RECETA (catálogo -> inventario)
// ==========================================================================
// A partir de window.db.recipes.getAllWithStock() (product_id, quantity_needed,
// inventory:{id,name,unit,stock,min_stock}), calcula el semáforo por producto:
//   - rojo: al menos un insumo no alcanza para 1 venta más.
//   - amarillo: alcanza, pero algún insumo ya está en su mínimo o por debajo.
//   - verde: receta completa con stock por encima del mínimo.
// Un producto sin filas de receta no aparece en el resultado (se trata como
// "sin receta" en el llamador -- no bloquea, es el flujo legacy).
function computeProductAvailability(recipesRaw) {
  const byProduct = {};
  (recipesRaw || []).forEach((r) => {
    const inv = r.inventory;
    if (!inv) return;
    if (!byProduct[r.product_id]) byProduct[r.product_id] = [];
    byProduct[r.product_id].push({
      insumoId: inv.id,
      name: inv.name,
      unit: inv.unit,
      stock: Number(inv.stock) || 0,
      minStock: Number(inv.min_stock) || 0,
      needed: Number(r.quantity_needed) || 0
    });
  });

  const result = {};
  Object.keys(byProduct).forEach((pid) => {
    const rows = byProduct[pid];
    let status = 'verde';
    let shortInsumo = null;
    let maxSellable = Infinity;
    rows.forEach((row) => {
      if (row.needed > 0) maxSellable = Math.min(maxSellable, Math.floor(row.stock / row.needed));
      if (row.stock < row.needed) {
        status = 'rojo';
        if (!shortInsumo) shortInsumo = row;
      } else if (status !== 'rojo' && row.stock <= row.minStock) {
        status = 'amarillo';
      }
    });
    result[pid] = { status, shortInsumo, maxSellable: maxSellable === Infinity ? null : maxSellable, insumos: rows };
  });
  return result;
}
