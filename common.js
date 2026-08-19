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

document.addEventListener('DOMContentLoaded', () => {
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
  ['Esc', 'Cerrar el modal abierto / cancelar']
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
// allowedRoles=null significa "cualquier usuario con sesión".
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
