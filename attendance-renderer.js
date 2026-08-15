let employees = [];
let todayRecords = [];
let currentSessionRole = null;

// ---------------- TABS ----------------
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('admin-only') && currentSessionRole !== 'admin') return;
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-panel').forEach((p) => (p.style.display = 'none'));
    document.getElementById(`tab-${btn.dataset.tab}`).style.display = 'block';
    if (btn.dataset.tab === 'employees') renderEmployeesTable();
    if (btn.dataset.tab === 'payroll') loadPayrollWeek();
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
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">Sin empleados registrados.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = employees
    .map(
      (emp) => `
    <tr>
      <td>${escapeHtml(emp.name)}</td>
      <td>${escapeHtml(emp.role)}</td>
      <td>${fmtMoney(emp.salary)}</td>
      <td>${fmtMoney(emp.weekly_bonus)}</td>
      <td><span class="tag ${emp.active ? 'active' : 'inactive'}">${emp.active ? 'Activo' : 'Inactivo'}</span></td>
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

// ---------------- NÓMINA SEMANAL ----------------
function mondayOf(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const day = d.getDay(); // 0=domingo
  const diff = day === 0 ? -6 : 1 - day; // retrocede hasta el lunes
  d.setDate(d.getDate() + diff);
  return localISODate(d);
}

async function loadPayrollWeek() {
  const picked = document.getElementById('week-picker').value;
  const weekStart = mondayOf(picked);
  document.getElementById('week-picker').value = weekStart;

  const rows = await window.db.payroll.getWeek(weekStart);
  renderPayrollKpis(rows);
  renderPayrollTable(rows, weekStart);
}

function renderPayrollKpis(rows) {
  const totalSalarios = rows.reduce((s, r) => s + r.salary, 0);
  const totalBonos = rows.reduce((s, r) => s + (r.bonusCredited ? r.weeklyBonus : 0), 0);
  const totalPagar = rows.reduce((s, r) => s + r.total, 0);

  document.getElementById('payroll-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">Salarios base</div>
      <div class="kpi-value">${fmtMoney(totalSalarios)}</div>
    </div>
    <div class="kpi-card success">
      <div class="kpi-label">Bonos acreditados</div>
      <div class="kpi-value">${fmtMoney(totalBonos)}</div>
    </div>
    <div class="kpi-card warning">
      <div class="kpi-label">Total a pagar esta semana</div>
      <div class="kpi-value">${fmtMoney(totalPagar)}</div>
    </div>
  `;
}

function renderPayrollTable(rows, weekStart) {
  const tbody = document.getElementById('payroll-tbody');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">No hay empleados activos.</div></td></tr>`;
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.employeeName)}</td>
      <td>${escapeHtml(r.role)}</td>
      <td>${fmtMoney(r.salary)}</td>
      <td>${fmtMoney(r.weeklyBonus)}</td>
      <td>
        <select data-bonus="${r.employeeId}" class="bonus-select">
          <option value="no" ${!r.bonusCredited ? 'selected' : ''}>No</option>
          <option value="si" ${r.bonusCredited ? 'selected' : ''}>Sí</option>
        </select>
      </td>
      <td>${fmtMoney(r.weeklyCreditAmount || 0)}</td>
      <td>${fmtMoney(r.weeklyCashExtra || 0)}</td>
      <td class="total-cell" data-total-for="${r.employeeId}">${fmtMoney(r.total)}</td>
    </tr>
  `
    )
    .join('');

  tbody.querySelectorAll('.bonus-select').forEach((select) => {
    select.addEventListener('change', async () => {
      const employeeId = Number(select.dataset.bonus);
      const credited = select.value === 'si';

      select.disabled = true;

      try {
        await window.db.payroll.setBonus({
          employeeId,
          weekStart,
          bonusCredited: credited
        });

        // Volvemos a consultar la semana completa para que salario, bono,
        // crédito semanal y cantidad neta a pagar queden sincronizados.
        const rows2 = await window.db.payroll.getWeek(weekStart);
        renderPayrollKpis(rows2);
        renderPayrollTable(rows2, weekStart);

        toast('Nómina actualizada.', 'success');
      } catch (err) {
        console.log('====================================');
  console.log('DEBUG NOMINA DESPUES DE GUARDAR BONO');
  console.log('====================================');
  console.log('SEMANA:', weekStart);
  console.log('EMPLEADO:', employeeId);
  console.log('ROWS2:', JSON.stringify(rows2, null, 2));

        toast(
          err?.message || 'No se pudo actualizar el bono.',
          'error'
        );
      } finally {
        select.disabled = false;
      }
    });
  });
}

document.getElementById('btn-load-week').addEventListener('click', loadPayrollWeek);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

document.addEventListener('DOMContentLoaded', async () => {
  const session = await guardSession(['admin', 'empleado']);
  if (!session) return;
  currentSessionRole = session.role;
  if (session.role !== 'admin') {
    document.querySelectorAll('.admin-only').forEach((el) => (el.style.display = 'none'));
  }
  document.getElementById('week-picker').value = mondayOf();
  loadData();
});