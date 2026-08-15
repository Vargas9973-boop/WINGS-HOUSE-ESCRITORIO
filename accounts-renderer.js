let users = [];
const ROLE_LABEL = { admin: 'Administrador', cajero: 'Cajero', empleado: 'Empleado' };

async function loadUsers() {
  users = await window.db.users.getAll();
  renderUsers();
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
      <td>${ROLE_LABEL[u.role] || u.role}</td>
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
  document.getElementById('user-role').value = u ? u.role : 'cajero';
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
  const role = document.getElementById('user-role').value;
  const active = document.getElementById('user-active').value === '1';
  const password = document.getElementById('user-password').value;

  if (!display_name || (!id && !username)) {
    toast('Usuario y nombre son obligatorios.', 'error');
    return;
  }

  try {
    if (id) {
      await window.db.users.update(Number(id), { display_name, role, active, password });
      toast('Cuenta actualizada.', 'success');
    } else {
      await window.db.users.create({ username, display_name, role, password: password || '123456' });
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

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardSession(['admin']);
  if (!session) return;
  loadUsers();
});
