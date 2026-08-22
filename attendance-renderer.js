let employees = [];
let todayRecords = [];
let currentSessionRole = null;
let biometricSettings = { enabled: false, model: 'u_are_u_4500' };
let biometricConnected = false;

// ---------------- TABS ----------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('admin-only') && currentSessionRole !== 'admin') return;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => (p.style.display = 'none'));
    document.getElementById(`tab-${btn.dataset.tab}`).style.display = 'block';
    if (btn.dataset.tab === 'employees') {
      await refreshBiometricStatus();
      renderEmployeesTable();
    }
    if (btn.dataset.tab === 'punch') refreshBiometricStatus();
  });
});

// ---------------- REGISTRO DE ASISTENCIA ----------------
async function loadData() {
  [employees, todayRecords] = await Promise.all([
    window.db.employees.getAll(),
    window.db.attendance.getToday()
  ]);
  renderPunchGrid();
  renderTodayTable();
}

function lastStatusFor(employeeId) {
  const records = todayRecords.filter((r) => r.employee_id === employeeId);
  if (records.length === 0) return 'out';
  return records[0].type === 'entrada' ? 'in' : 'out';
}

function renderPunchGrid() {
  const grid = document.getElementById('employee-punch-grid');
  const active = employees.filter((e) => e.active);
  if (active.length === 0) {
    grid.innerHTML = `<div class="empty-state">Registra a tu primer empleado para comenzar a tomar asistencia.</div>`;
    return;
  }
  grid.innerHTML = active
    .map((emp) => {
      const status = lastStatusFor(emp.id);
      return `
      <div class="punch-card">
        <h3>${escapeHtml(emp.name)}</h3>
        <span class="role">${escapeHtml(emp.role)}</span>
        <span class="status ${status}">${status === 'in' ? '● Dentro del turno' : '○ Fuera de turno'}</span>
        <button class="btn ${status === 'in' ? 'btn-danger' : 'btn-brand'}" data-punch="${emp.id}">
          ${status === 'in' ? 'Registrar salida' : 'Registrar entrada'}
        </button>
      </div>
    `;
    })
    .join('');

  grid.querySelectorAll('[data-punch]').forEach((b) =>
    b.addEventListener('click', () => registerPunch(Number(b.dataset.punch)))
  );
}

// ---------------- BIOMETRÍA (lector de huella opcional) ----------------
// Sondea Ajustes + hardware; si el lector no está habilitado o no se
// detecta, deja la grilla de botones manuales exactamente como siempre.
async function refreshBiometricStatus() {
  const statusEl = document.getElementById('biometric-reader-status');
  const scanArea = document.getElementById('biometric-scan-area');
  const punchGrid = document.getElementById('employee-punch-grid');
  const thHuella = document.getElementById('th-huella');

  try {
    biometricSettings = await window.biometricAPI.getSettings();
  } catch (err) {
    biometricSettings = { enabled: false, model: 'u_are_u_4500' };
  }

  if (thHuella) thHuella.style.display = biometricSettings.enabled ? '' : 'none';

  let connected = false;
  if (biometricSettings.enabled) {
    try {
      const result = await window.biometricAPI.scan(biometricSettings.model);
      connected = !!(result && result.connected);
    } catch (err) {
      connected = false;
    }
  }
  biometricConnected = connected;

  if (connected) {
    statusEl.className = 'status-indicator connected';
    statusEl.textContent = '● Conectado';
    scanArea.style.display = 'flex';
    punchGrid.style.display = 'none';
  } else {
    statusEl.className = 'status-indicator disconnected';
    statusEl.textContent = '○ No conectado - Usando modo manual';
    scanArea.style.display = 'none';
    punchGrid.style.display = 'grid';
  }
}

async function registerPunch(employeeId) {
  try {
    const record = await window.db.attendance.register(employeeId);
    toast(`${record.employee_name}: ${record.type === 'entrada' ? 'entrada' : 'salida'} registrada.`, 'success');
    loadData();
  } catch (err) {
    toast('No se pudo registrar el movimiento.', 'error');
  }
}

function renderTodayTable() {
  const tbody = document.getElementById('attendance-tbody');
  if (todayRecords.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">Sin movimientos registrados hoy.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = todayRecords
    .map(
      (r) => `
    <tr>
      <td>${fmtDate(r.timestamp)}</td>
      <td>${escapeHtml(r.employee_name)}</td>
      <td><span class="tag ${r.type === 'entrada' ? 'active' : 'inactive'}">${r.type === 'entrada' ? 'Entrada' : 'Salida'}</span></td>
    </tr>
  `
    )
    .join('');
}

// ---------------- EMPLEADOS (salario y bono) ----------------
function renderEmployeesTable() {
  const tbody = document.getElementById('employees-tbody');
  if (employees.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Sin empleados registrados.</div></td></tr>`;
    return;
  }
  const huellaDisplay = biometricSettings.enabled ? '' : 'display:none;';
  tbody.innerHTML = employees
    .map(
      (emp) => `
    <tr>
      <td>${escapeHtml(emp.name)}</td>
      <td>${escapeHtml(emp.role)}</td>
      <td>${fmtMoney(emp.salary)}</td>
      <td>${fmtMoney(emp.weekly_bonus)}</td>
      <td><span class="tag ${emp.active ? 'active' : 'inactive'}">${emp.active ? 'Activo' : 'Inactivo'}</span></td>
      <td class="td-huella" style="${huellaDisplay}">
        ${emp.fingerprint_enrolled
          ? '<span class="tag active">✓ Registrada</span>'
          : `<button class="btn btn-outline btn-sm" data-enroll="${emp.id}">Registrar huella</button>`}
      </td>
      <td>
        <button class="btn btn-outline btn-sm" data-edit="${emp.id}">Editar</button>
        <button class="btn btn-danger btn-sm" data-remove="${emp.id}">Eliminar</button>
      </td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEmployeeModal(Number(b.dataset.edit))));
  tbody.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeEmployee(Number(b.dataset.remove))));
  tbody.querySelectorAll('[data-enroll]').forEach((b) => b.addEventListener('click', () => enrollFingerprint(Number(b.dataset.enroll))));
}

async function enrollFingerprint(employeeId) {
  try {
    await window.biometricAPI.enroll(employeeId);
    toast('Huella registrada.', 'success');
    await loadData();
    renderEmployeesTable();
  } catch (err) {
    toast(err?.message || 'No se pudo registrar la huella.', 'error');
  }
}

function openEmployeeModal(id = null) {
  const emp = id ? employees.find((e) => e.id === id) : null;
  document.getElementById('employee-modal-title').textContent = emp ? 'Editar empleado' : 'Nuevo empleado';
  document.getElementById('employee-id').value = emp ? emp.id : '';
  document.getElementById('employee-name').value = emp ? emp.name : '';
  document.getElementById('employee-role').value = emp ? emp.role : '';
  document.getElementById('employee-salary').value = emp ? emp.salary : '';
  document.getElementById('employee-bonus').value = emp ? emp.weekly_bonus : '';
  document.getElementById('employee-active').value = emp ? String(emp.active) : '1';
  openModal('employee-modal');
}

document.getElementById('btn-new-employee').addEventListener('click', () => openEmployeeModal());
document.getElementById('btn-cancel-employee').addEventListener('click', () => closeModal('employee-modal'));

document.getElementById('btn-save-employee').addEventListener('click', async () => {
  const id = document.getElementById('employee-id').value;
  const name = document.getElementById('employee-name').value.trim();
  const role = document.getElementById('employee-role').value.trim() || 'Personal';
  const salary = Number(document.getElementById('employee-salary').value) || 0;
  const weekly_bonus = Number(document.getElementById('employee-bonus').value) || 0;
  const active = document.getElementById('employee-active').value === '1';

  if (!name) {
    toast('El nombre es obligatorio.', 'error');
    return;
  }

  try {
    if (id) {
      await window.db.employees.update(Number(id), { name, role, salary, weekly_bonus, active });
      toast('Empleado actualizado.', 'success');
    } else {
    console.log('ENVIANDO EMPLEADO A DB:', {
        name,
        role,
        salary,
        weekly_bonus,
        active
    });

    await window.db.employees.create({
        name,
        role,
        salary,
        weekly_bonus,
        active
    });

    toast('Empleado registrado.', 'success');
}
    closeModal('employee-modal');
    await loadData();
    renderEmployeesTable();
  } catch (err) {
    console.error('Error al guardar empleado:', err);
    toast(err?.message || 'No se pudo guardar el empleado.', 'error');
  }
});

async function removeEmployee(id) {
  if (!confirm('¿Eliminar este empleado?')) return;
  try {
    const res = await window.db.employees.remove(id);
    toast(res.deactivated ? 'Tiene historial de asistencia: se marcó como inactivo.' : 'Empleado eliminado.', 'success');
    await loadData();
    renderEmployeesTable();
  } catch (err) {
    console.error('Error al eliminar empleado:', err);
    toast(err?.message || 'No se pudo eliminar el empleado.', 'error');
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardPermission('asistencia', 'can_view');
  if (!session) return;
  currentSessionRole = session.role;
  if (session.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach((el) => (el.style.display = 'none'));
  }
  loadData();
  refreshBiometricStatus();
  // Sondeo periódico: detecta si el lector se conecta/desconecta mientras
  // la pantalla sigue abierta, sin que el usuario tenga que recargar.
  setInterval(refreshBiometricStatus, 8000);
});