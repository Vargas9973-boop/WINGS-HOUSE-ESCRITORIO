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
