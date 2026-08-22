let users = [];
let roles = [];
let selectedRoleId = null;
const ROLE_LABEL = { admin: 'Administrador', cajero: 'Cajero', empleado: 'Empleado' };

// Mismo orden en las 3 pantallas: aquí (checkboxes), en la migración SQL
// (semilla de role_permissions) y en cada guardPermission('modulo', ...)
// de los renderers ya migrados -- si agregas un módulo nuevo, agrégalo en
// los 3 lugares.
const MODULES = [
  { key: 'ventas', label: 'Ventas' },
  { key: 'kds', label: 'KDS (cocina)' },
  { key: 'comandas', label: 'Comandas' },
  { key: 'catalogo', label: 'Catálogo' },
  { key: 'inventario', label: 'Inventario / Merma' },
  { key: 'corte', label: 'Corte de caja' },
  { key: 'costos', label: 'Costos' },
  { key: 'asistencia', label: 'Asistencia' },
  { key: 'nomina', label: 'Nómina' },
  { key: 'historial', label: 'Historial' },
  { key: 'reportes', label: 'Reportes' },
  { key: 'ajustes', label: 'Ajustes' },
  { key: 'cuentas', label: 'Cuentas' }
];

async function loadUsers() {
  users = await window.db.users.getAll();
  renderUsers();
}

async function loadRoles() {
  roles = await window.db.roles.getAll();
  renderRoles();
  renderRoleSelect();
}

function renderRoleSelect() {
  const select = document.getElementById('user-role');
  const current = select.value;
  select.innerHTML = roles.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}</option>`).join('');
  if (current) select.value = current;
}

function renderUsers() {
  const tbody = document.getElementById('users-tbody');
  if (users.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state">Sin usuarios.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = users
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${escapeHtml(u.display_name)}</td>
      <td>${escapeHtml(u.roleName || ROLE_LABEL[u.role] || u.role)}</td>
      <td><span class="tag ${u.active ? 'active' : 'inactive'}">${u.active ? 'Activo' : 'Inactivo'}</span></td>
      <td>
        <button class="btn btn-outline btn-sm" data-edit="${u.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-remove="${u.id}">Desactivar</button>
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openUserModal(Number(b.dataset.edit))));
  tbody.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeUser(Number(b.dataset.remove))));
}

function openUserModal(id = null) {
  const u = id ? users.find((x) => x.id === id) : null;
  document.getElementById('user-modal-title').textContent = u ? 'Editar cuenta' : 'Nueva cuenta';
  document.getElementById('user-id').value = u ? u.id : '';
  document.getElementById('user-username').value = u ? u.username : '';
  document.getElementById('user-username').disabled = !!u;
  document.getElementById('user-display-name').value = u ? u.display_name : '';
  renderRoleSelect();
  document.getElementById('user-role').value = u && u.role_id ? String(u.role_id) : (roles.find((r) => r.name === 'Cajero') || roles[0] || {}).id || '';
  document.getElementById('user-active').value = u ? String(u.active) : '1';
  document.getElementById('user-password').value = '';
  document.getElementById('user-password-label').textContent = u ? 'Nueva contraseña (opcional)' : 'Contraseña';
  document.getElementById('user-password').placeholder = u ? 'Déjalo vacío para no cambiarla' : 'Contraseña inicial';
  openModal('user-modal');
}

document.getElementById('btn-new-user').addEventListener('click', () => openUserModal());
document.getElementById('btn-cancel-user').addEventListener('click', () => closeModal('user-modal'));

document.getElementById('btn-save-user').addEventListener('click', async () => {
  const id = document.getElementById('user-id').value;
  const username = document.getElementById('user-username').value.trim();
  const display_name = document.getElementById('user-display-name').value.trim();
  const roleId = Number(document.getElementById('user-role').value) || null;
  const active = document.getElementById('user-active').value === '1';
  const password = document.getElementById('user-password').value;

  if (!display_name || (!id && !username) || !roleId) {
    toast('Usuario, nombre y rol son obligatorios.', 'error');
    return;
  }

  try {
    if (id) {
      await window.db.users.update(Number(id), { display_name, roleId, active, password });
      toast('Cuenta actualizada.', 'success');
    } else {
      await window.db.users.create({ username, display_name, roleId, password: password || '123456' });
      toast('Cuenta creada.', 'success');
    }
    closeModal('user-modal');
    loadUsers();
  } catch (err) {
    toast(err.message || 'No se pudo guardar la cuenta.', 'error');
  }
});

async function removeUser(id) {
  if (!confirm('¿Desactivar esta cuenta? No podrá iniciar sesión.')) return;
  try {
    await window.db.users.remove(id);
    toast('Cuenta desactivada.', 'success');
    loadUsers();
  } catch (err) {
    toast(err.message || 'No se pudo desactivar la cuenta.', 'error');
  }
}

// ==========================================================================
// ROLES Y PERMISOS
// ==========================================================================
function renderRoles() {
  const tbody = document.getElementById('roles-tbody');
  if (roles.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Sin roles.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = roles
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.name)}${r.is_system ? ' <span class="tag active">Sistema</span>' : ''}</td>
      <td>${escapeHtml(r.description || '')}</td>
      <td>
        <button class="btn btn-outline btn-sm" data-permissions="${r.id}">Permisos</button>
        ${r.is_system ? '' : `<button class="btn btn-outline btn-sm" data-edit-role="${r.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-remove-role="${r.id}">Eliminar</button>`}
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-permissions]').forEach((b) =>
    b.addEventListener('click', () => openRolePermissions(Number(b.dataset.permissions)))
  );
  tbody.querySelectorAll('[data-edit-role]').forEach((b) =>
    b.addEventListener('click', () => openRoleModal(Number(b.dataset.editRole)))
  );
  tbody.querySelectorAll('[data-remove-role]').forEach((b) =>
    b.addEventListener('click', () => removeRole(Number(b.dataset.removeRole)))
  );
}

function openRoleModal(id = null) {
  const r = id ? roles.find((x) => x.id === id) : null;
  document.getElementById('role-modal-title').textContent = r ? 'Editar rol' : 'Nuevo rol';
  document.getElementById('role-id').value = r ? r.id : '';
  document.getElementById('role-name').value = r ? r.name : '';
  document.getElementById('role-description').value = r ? r.description || '' : '';
  openModal('role-modal');
}

document.getElementById('btn-new-role').addEventListener('click', () => openRoleModal());
document.getElementById('btn-cancel-role').addEventListener('click', () => closeModal('role-modal'));

document.getElementById('btn-save-role').addEventListener('click', async () => {
  const id = document.getElementById('role-id').value;
  const name = document.getElementById('role-name').value.trim();
  const description = document.getElementById('role-description').value.trim();
  if (!name) {
    toast('El nombre del rol es obligatorio.', 'error');
    return;
  }
  try {
    if (id) {
      await window.db.roles.update(Number(id), { name, description });
      toast('Rol actualizado.', 'success');
    } else {
      await window.db.roles.create({ name, description });
      toast('Rol creado.', 'success');
    }
    closeModal('role-modal');
    await loadRoles();
  } catch (err) {
    toast(err.message || 'No se pudo guardar el rol.', 'error');
  }
});

async function removeRole(id) {
  if (!confirm('¿Eliminar este rol? Solo se puede si no tiene cuentas asignadas.')) return;
  try {
    await window.db.roles.remove(id);
    toast('Rol eliminado.', 'success');
    if (selectedRoleId === id) {
      selectedRoleId = null;
      document.getElementById('role-permissions-panel').style.display = 'none';
    }
    await loadRoles();
  } catch (err) {
    toast(err.message || 'No se pudo eliminar el rol.', 'error');
  }
}

async function openRolePermissions(roleId) {
  selectedRoleId = roleId;
  const role = roles.find((r) => r.id === roleId);
  const panel = document.getElementById('role-permissions-panel');
  const tbody = document.getElementById('role-permissions-tbody');
  document.getElementById('role-permissions-title').textContent = `Permisos: ${role ? role.name : ''}`;
  panel.style.display = 'block';

  let current = [];
  try {
    current = await window.db.roles.getPermissions(roleId);
  } catch (err) {
    toast('No se pudieron cargar los permisos de este rol.', 'error');
  }
  const byModule = {};
  current.forEach((p) => (byModule[p.module] = p));

  tbody.innerHTML = MODULES.map((m) => {
    const p = byModule[m.key] || {};
    const chk = (action) => `<input type="checkbox" data-module="${m.key}" data-action="${action}" ${p[action] ? 'checked' : ''}>`;
    return `<tr>
      <td>${escapeHtml(m.label)}</td>
      <td>${chk('can_view')}</td>
      <td>${chk('can_create')}</td>
      <td>${chk('can_edit')}</td>
      <td>${chk('can_delete')}</td>
    </tr>`;
  }).join('');

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('btn-save-role-permissions').addEventListener('click', async () => {
  if (!selectedRoleId) return;
  const btn = document.getElementById('btn-save-role-permissions');
  btn.disabled = true;
  try {
    const permissions = MODULES.map((m) => ({
      module: m.key,
      can_view: document.querySelector(`[data-module="${m.key}"][data-action="can_view"]`).checked,
      can_create: document.querySelector(`[data-module="${m.key}"][data-action="can_create"]`).checked,
      can_edit: document.querySelector(`[data-module="${m.key}"][data-action="can_edit"]`).checked,
      can_delete: document.querySelector(`[data-module="${m.key}"][data-action="can_delete"]`).checked
    }));
    await window.db.roles.setPermissions(selectedRoleId, permissions);
    toast('Permisos guardados.', 'success');
  } catch (err) {
    toast(err.message || 'No se pudieron guardar los permisos.', 'error');
  } finally {
    btn.disabled = false;
  }
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardPermission('cuentas', 'can_view');
  if (!session) return;
  await loadRoles();
  loadUsers();
});
