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
});

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
