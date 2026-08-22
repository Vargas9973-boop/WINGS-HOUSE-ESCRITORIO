// db.js — Capa de datos sobre Supabase (PostgreSQL). Reemplaza el db.js que
// usaba sql.js/SQLite. Expone funciones async con el mismo nombre/forma que
// necesita main.js, para que el resto de la app (preload, renderers, html)
// no tenga que cambiar absolutamente nada.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const supabase = require('./supabaseClient');

// ==========================================================================
// CONTRASEÑAS (idéntico al db.js original: scrypt + sal individual)
// ==========================================================================
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeCredentials(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function must(error, msg) {
  if (error) throw new Error(msg ? `${msg}: ${error.message}` : error.message);
}

// ==========================================================================
// SUCURSAL — cada instalación de escritorio sirve UNA sucursal física (la
// terminal vive en un local), así que el branch pertenece a la instalación,
// no a la sesión de quién inició sesión (a diferencia de la web, donde
// cualquier empleado puede entrar desde cualquier lado -- ver
// wing-house-web/src/components/Login.jsx). main.js resuelve el valor real
// (archivo de config en app.getPath('userData'), con bootstrap automático
// si solo existe una sucursal en la base) y lo inyecta aquí con
// setCurrentBranchId() antes de llamar a db.init(). Si nadie lo configura,
// getCurrentBranchId() lanza en vez de caer en silencio a la sucursal 1 --
// esa era exactamente la regla que no se podía romper.
let _currentBranchId = null;

function setCurrentBranchId(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`branch_id inválido: ${id}`);
  }
  _currentBranchId = n;
}

function getCurrentBranchId() {
  if (_currentBranchId == null) {
    throw new Error('La sucursal de esta instalación todavía no está configurada (setCurrentBranchId).');
  }
  return _currentBranchId;
}

// Usada solo por main.js durante el arranque, ANTES de que haya un
// currentBranchId, para poder resolverlo (bootstrap automático si solo hay
// una sucursal en la base, o listado para que el admin elija si hay más de
// una). No requiere branch_id porque branches es la tabla raíz.
async function getAllBranches() {
  const { data, error } = await supabase.from('branches').select('*').order('id');
  must(error, 'No se pudieron obtener las sucursales');
  return data || [];
}

// ==========================================================================
// NÓMINA — semana laboral configurable (settings.payroll_payday)
// ==========================================================================
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Dada la config de día de pago (0=domingo..6=sábado) y una fecha de
// referencia, retorna la semana laboral [start,end] que contiene esa fecha.
// La semana EMPIEZA el día siguiente al de pago (p.ej. payday=sábado ->
// semana = domingo a sábado) y "end" es justo el día de pago. Importante:
// el día siguiente a un payday ya pertenece a la semana NUEVA (la que aún
// no se paga), no a la que acaba de cerrar -- si esto se calculara como
// "el payday más reciente <= referencia" el domingo posterior al pago
// quedaría mal agrupado con la semana ya cerrada.
function getWeekRange(paydayNumber, referenceDate) {
  const payday = Number.isInteger(paydayNumber) ? ((paydayNumber % 7) + 7) % 7 : 6;
  const weekStartDay = (payday + 1) % 7;
  const ref = referenceDate ? new Date(`${referenceDate}T00:00:00`) : new Date();
  ref.setHours(0, 0, 0, 0);
  const diff = (ref.getDay() - weekStartDay + 7) % 7;
  const start = new Date(ref);
  start.setDate(start.getDate() - diff);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start: localDateStr(start), end: localDateStr(end) };
}

// payroll_weeks y employee_weekly_credit (bono acreditado y crédito semanal
// por excedente) se acumulan por semana ISO lunes-domingo -- así los siembra
// process_sale con date_trunc('week', ...), sin importar el día de pago
// configurado en Ajustes. getWeekRange arriba sí respeta ese día de pago
// para el rango que se muestra en pantalla (p.ej. domingo-sábado si el pago
// es sábado), así que para leer/escribir esas dos tablas hay que traducir
// la semana visible a su lunes ISO. Se ancla en weekEnd (el día de pago)
// porque ese es el día que sí cae siempre dentro de la semana ISO correcta;
// weekStart puede caer un día antes y pertenecer a la semana ISO anterior.
function isoMondayOf(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return localDateStr(d);
}

// ==========================================================================
// ARRANQUE — siembra las cuentas por defecto si la tabla 'users' está vacía.
// El resto del catálogo/inventario/ajustes ya se siembra desde el script SQL
// (supabase_schema.sql) porque no necesita hashing en Node.
// ==========================================================================
async function seedUsersIfEmpty() {
  const { count, error } = await supabase.from('users').select('id', { count: 'exact', head: true });
  must(error, 'No se pudo verificar la tabla de usuarios');
  if (count && count > 0) return;

  const accounts = [
    { username: 'admin', display_name: 'Administrador', role: 'admin', password: 'admin123' },
    { username: 'cajero1', display_name: 'Cajero 1', role: 'cajero', password: 'cajero123' },
    { username: 'cajero2', display_name: 'Cajero 2', role: 'cajero', password: 'cajero123' },
    { username: 'empleado', display_name: 'Empleado', role: 'empleado', password: 'empleado123' }
  ];
  const rows = accounts.map((acc) => {
    const { salt, hash } = makeCredentials(acc.password);
    return {
      username: acc.username,
      name: acc.display_name,
      role: acc.role,
      // Columna legacy NOT NULL: se mantiene poblada por compatibilidad con
      // el esquema real de Supabase; la autenticación real usa password_hash.
      password: acc.password,
      password_hash: hash,
      password_salt: salt
    };
  });
  const { error: insErr } = await supabase.from('users').insert(rows);
  must(insErr, 'No se pudieron crear las cuentas iniciales');
}

async function init() {
  await seedUsersIfEmpty();
  await migrateAlitasBonelessCategories();
  return true;
}

// ==========================================================================
// 1. AUTENTICACIÓN Y CUENTAS
// ==========================================================================
async function login(username, password) {
  const cleanUsername = String(username || '').trim().toLowerCase();

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('username', cleanUsername)
    .eq('branch_id', getCurrentBranchId())
    .eq('active', true)
    .maybeSingle();

  must(error, 'Error al consultar el usuario en Supabase');
  if (!user) throw new Error('Usuario o contraseña incorrectos.');

  if (user.password_hash && user.password_salt) {
    const hash = hashPassword(password || '', user.password_salt);
    if (hash !== user.password_hash) {
      throw new Error('Usuario o contraseña incorrectos.');
    }
  } else if (typeof user.password === 'string') {
    if (user.password !== String(password || '')) {
      throw new Error('Usuario o contraseña incorrectos.');
    }

    const { salt, hash } = makeCredentials(password || '');
    const { error: migrateErr } = await supabase
      .from('users')
      .update({ password_hash: hash, password_salt: salt })
      .eq('id', user.id);

    must(migrateErr, 'No se pudo actualizar la contraseña del usuario');
  } else {
    throw new Error('La cuenta no tiene una contraseña configurada correctamente.');
  }

  // Permisos por módulo (Cuentas -> Roles): si el usuario no tiene role_id
  // (instalación previa a esta función, o el rol se borró) la RPC devuelve
  // vacío -- no rompe el login, hasPermission() cae al criterio viejo
  // (role === 'admin') cuando el arreglo de permisos viene vacío.
  const permissions = await getUserPermissions(user.id);

  return {
    id: user.id,
    username: user.username,
    displayName: user.name,
    role: user.role,
    roleId: user.role_id || null,
    permissions
  };
}

// Devuelve [] en vez de tronar si la RPC falla (rol borrado, instalación
// vieja sin backfill, etc.) -- el login nunca debe fallar por esto.
async function getUserPermissions(userId) {
  try {
    const { data, error } = await supabase.rpc('get_user_permissions', { p_user_id: userId });
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.warn('No se pudieron obtener los permisos del usuario:', err.message || err);
    return [];
  }
}

async function changePassword(userId, newPassword) {
  if (!newPassword || newPassword.length < 4) throw new Error('La contraseña debe tener al menos 4 caracteres.');
  const { salt, hash } = makeCredentials(newPassword);
  // La columna legacy 'password' es NOT NULL en Supabase; se mantiene en
  // sincronía con el hash (no se guarda en texto plano) para no violar la
  // restricción y para que no quede una contraseña anterior obsoleta ahí.
  const { error } = await supabase.from('users').update({ password: hash, password_hash: hash, password_salt: salt }).eq('id', userId).eq('branch_id', getCurrentBranchId());
  must(error, 'No se pudo cambiar la contraseña');
  return true;
}

async function getAllUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, display_name:name, role, role_id, active, created_at, roles(name, is_system)')
    .eq('branch_id', getCurrentBranchId())
    .order('role', { ascending: true })
    .order('username', { ascending: true });
  must(error, 'No se pudieron obtener las cuentas');
  return (data || []).map((u) => ({ ...u, roleName: u.roles ? u.roles.name : null, roles: undefined }));
}

// role_id es la fuente de verdad nueva (Cuentas -> Roles); `role` (texto,
// 'admin'/'cajero'/...) se sigue rellenando en minúsculas desde el nombre
// del rol elegido para no romper el resto del código que todavía lo lee
// (login, guardSession(['admin',...]) que aún no se hayan migrado, etc.).
async function resolveRoleForUser(roleId, fallbackRoleText) {
  if (roleId) {
    const { data: role, error } = await supabase
      .from('roles')
      .select('id, name')
      .eq('id', roleId)
      .eq('branch_id', getCurrentBranchId())
      .maybeSingle();
    must(error, 'No se pudo verificar el rol');
    if (!role) throw new Error('El rol seleccionado no existe en esta sucursal.');
    return { roleId: role.id, roleText: role.name.toLowerCase() };
  }
  return { roleId: null, roleText: fallbackRoleText || 'cajero' };
}

async function createUser(data) {
  const username = String(data.username || '').trim().toLowerCase();
  if (!username) throw new Error('El usuario es obligatorio.');
  const { data: existing, error: exErr } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
  must(exErr);
  if (existing) throw new Error('Ese nombre de usuario ya existe.');
  const { salt, hash } = makeCredentials(data.password || '123456');
  const { roleId, roleText } = await resolveRoleForUser(data.roleId, data.role);
  const { data: created, error } = await supabase
    .from('users')
    .insert([{
      username,
      name: data.display_name || username,
      role: roleText,
      role_id: roleId,
      // Columna legacy NOT NULL en Supabase; se rellena con el hash (no en
      // texto plano) para no violar la restricción sin exponer la contraseña.
      password: hash,
      password_hash: hash,
      password_salt: salt,
      active: data.active !== false,
      branch_id: getCurrentBranchId()
    }])
    .select('id, username, display_name:name, role, role_id, active')
    .single();
  must(error, 'No se pudo crear la cuenta');
  return created;
}

async function updateUser(id, data) {
  const { roleId, roleText } = await resolveRoleForUser(data.roleId, data.role);
  const patch = {
    name: data.display_name,
    role: roleText,
    role_id: roleId,
    active: data.active !== false
  };
  const { error } = await supabase.from('users').update(patch).eq('id', id).eq('branch_id', getCurrentBranchId());
  must(error, 'No se pudo actualizar la cuenta');
  if (data.password) {
    const { salt, hash } = makeCredentials(data.password);
    const { error: pwErr } = await supabase.from('users').update({ password: hash, password_hash: hash, password_salt: salt }).eq('id', id).eq('branch_id', getCurrentBranchId());
    must(pwErr, 'No se pudo actualizar la contraseña');
  }
  const { data: row, error: selErr } = await supabase
    .from('users').select('id, username, display_name:name, role, role_id, active').eq('id', id).eq('branch_id', getCurrentBranchId()).single();
  must(selErr);
  return row;
}

async function removeUser(id) {
  const { error } = await supabase.from('users').update({ active: false }).eq('id', id).eq('branch_id', getCurrentBranchId());
  must(error, 'No se pudo desactivar la cuenta');
  return { deactivated: true };
}

// ==========================================================================
// 1B. ROLES Y PERMISOS (Cuentas -> "Permisos por rol")
// ==========================================================================
async function getRoles() {
  const { data, error } = await supabase.rpc('get_roles_by_branch', { p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudieron obtener los roles');
  return data || [];
}

async function createRole(data) {
  const { data: row, error } = await supabase.rpc('create_role', {
    p_branch_id: getCurrentBranchId(),
    p_name: data.name,
    p_description: data.description || null
  });
  must(error, 'No se pudo crear el rol');
  return row;
}

async function updateRole(id, data) {
  const { data: row, error } = await supabase.rpc('update_role', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_name: data.name,
    p_description: data.description || null
  });
  must(error, 'No se pudo actualizar el rol');
  return row;
}

async function removeRole(id) {
  const { error } = await supabase.rpc('remove_role', { p_branch_id: getCurrentBranchId(), p_id: id });
  must(error, 'No se pudo eliminar el rol');
  return { deleted: true };
}

async function getRolePermissions(roleId) {
  const { data, error } = await supabase.rpc('get_role_permissions', {
    p_branch_id: getCurrentBranchId(),
    p_role_id: roleId
  });
  must(error, 'No se pudieron obtener los permisos del rol');
  return data || [];
}

// permissions: [{ module, can_view, can_create, can_edit, can_delete }, ...]
// -- siempre manda el arreglo completo de los 13 módulos, la RPC hace upsert
// de cada uno (no borra los que falten, así que si la UI omite un módulo
// por error, ese permiso simplemente no cambia -- no queda en blanco).
async function setRolePermissions(roleId, permissions) {
  const { data, error } = await supabase.rpc('set_role_permissions', {
    p_branch_id: getCurrentBranchId(),
    p_role_id: roleId,
    p_permissions: permissions || []
  });
  must(error, 'No se pudo guardar los permisos del rol');
  return data;
}

// ==========================================================================
// 2. PRODUCTOS (Catálogo)
// ==========================================================================

// Categorías fijas: antes existía una sola categoría combinada
// "Alitas y Boneless"; ahora son dos independientes con estos valores
// exactos guardados en products.category.
const CATEGORY_ALITAS = 'Alitas';
const CATEGORY_BONELESS = 'Boneless';

// Migra productos que quedaron con la categoría combinada legacy (el valor
// literal "Alitas y Boneless", o las claves antiguas en minúsculas
// 'alitas'/'boneless' que usó una versión anterior de esta app) a los
// valores definitivos 'Alitas' / 'Boneless', decidiendo por el nombre del
// producto. Idempotente: se puede llamar en cada arranque sin efecto una
// vez que ya no quedan filas legacy.
async function migrateAlitasBonelessCategories() {
  try {
    const branchId = getCurrentBranchId();
    if (!branchId) {
      console.warn('[MIGRATION] No hay branchId, se omite migración alitas/boneless');
      return;
    }
    const { data, error } = await supabase.rpc('migrate_alitas_boneless_categories', { p_branch_id: branchId });
    if (error) {
      console.warn('[MIGRATION] migrate_alitas_boneless_categories skip:', error.message);
      return;
    }
    // La función puede regresar null/void, no intentar leer propiedades
    if (!data) {
      console.log('[MIGRATION] Alitas/Boneless OK para branch', branchId);
      return;
    }
    // Si algún día regresa algo, usar optional chaining
    console.log('[MIGRATION] resultado:', data?.toBoneless ?? data);
  } catch (e) {
    console.warn('[MIGRATION] Alitas/Boneless error capturado:', e.message);
    // No lanzar, para no romper el init
    return;
  }
}

function normalizeStock(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getAllProducts() {
  const { data, error } = await supabase.rpc('get_products_by_branch', { p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudieron obtener los productos');
  return data;
}

async function createProduct(data) {
  const { data: row, error } = await supabase.rpc('create_product', {
    p_branch_id: getCurrentBranchId(),
    p_name: data.name,
    p_category: data.category,
    p_price: Number(data.price) || 0,
    p_employee_price: data.employee_price ? Number(data.employee_price) : null,
    p_active: data.active !== false,
    p_sort_order: Number(data.sort_order) || 0,
    p_stock: normalizeStock(data.stock),
    p_cost_per_unit: data.cost_per_unit != null && data.cost_per_unit !== '' ? Number(data.cost_per_unit) : null
  });
  must(error, 'No se pudo crear el producto');
  return row;
}

async function updateProduct(id, data) {
  const { data: row, error } = await supabase.rpc('update_product', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_name: data.name,
    p_category: data.category,
    p_price: Number(data.price) || 0,
    p_employee_price: data.employee_price ? Number(data.employee_price) : null,
    p_active: data.active !== false,
    p_sort_order: Number(data.sort_order) || 0,
    p_stock: normalizeStock(data.stock),
    p_cost_per_unit: data.cost_per_unit != null && data.cost_per_unit !== '' ? Number(data.cost_per_unit) : null
  });
  must(error, 'No se pudo actualizar el producto');
  return row;
}

async function adjustProductStock(id, delta) {
  const { data: row, error } = await supabase.rpc('adjust_product_stock', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_delta: Number(delta)
  });
  must(error, 'No se pudo ajustar la existencia');
  return row;
}

async function removeProduct(id) {
  const { data, error } = await supabase.rpc('remove_product', { p_branch_id: getCurrentBranchId(), p_id: id });
  must(error, 'No se pudo eliminar el producto');
  return data;
}

// ==========================================================================
// 3. PROMOCIONES
// ==========================================================================
async function getAllPromotions() {
  const { data, error } = await supabase
    .from('promotions').select('*')
    .eq('branch_id', getCurrentBranchId())
    .order('active', { ascending: false })
    .order('created_at', { ascending: false });
  must(error, 'No se pudieron obtener las promociones');
  return data;
}

async function createPromotion(data) {
  const { data: row, error } = await supabase.rpc('create_promotion', {
    p_branch_id: getCurrentBranchId(),
    p_name: data.name,
    p_description: data.description || '',
    p_price: Number(data.price) || 0,
    p_active: data.active !== false,
    p_applicable_category: data.applicable_category || null
  });
  must(error, 'No se pudo crear la promoción');
  return row;
}

async function updatePromotion(id, data) {
  const { data: row, error } = await supabase.rpc('update_promotion', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_name: data.name,
    p_description: data.description || '',
    p_price: Number(data.price) || 0,
    p_active: data.active !== false,
    p_applicable_category: data.applicable_category || null
  });
  must(error, 'No se pudo actualizar la promoción');
  return row;
}

async function removePromotion(id) {
  const { data, error } = await supabase.rpc('remove_promotion', { p_branch_id: getCurrentBranchId(), p_id: id });
  must(error, 'No se pudo eliminar la promoción');
  return data;
}

// ==========================================================================
// 4. VENTAS
// ==========================================================================
function mapCartItems(items) {
  return (items || []).map((item) => ({
    ref_id: item.id ?? item.ref_id ?? null,
    item_type: item.itemType || item.item_type || 'product',
    name: item.name,
    unit_price: Number(item.price ?? item.unit_price) || 0,
    quantity: Number(item.quantity) || 1
  }));
}

// Beneficio diario/crédito semanal configurables desde Ajustes (Settings,
// key-value): antes 100/500 estaban hardcodeados dentro de process_sale.
// Fallback a los mismos valores de siempre si la key no existe (instalación
// previa a este ajuste) o viene corrupta.
async function getEmployeeBenefitSettings() {
  const settings = await getAllSettings();
  return {
    benefitEnabled: settings.benefit_enabled !== 'false',
    benefitDailyAmount: Number(settings.benefit_daily_amount) > 0 ? Number(settings.benefit_daily_amount) : 100,
    weeklyCreditEnabled: settings.weekly_credit_enabled !== 'false',
    weeklyCreditLimit: Number(settings.weekly_credit_limit) > 0 ? Number(settings.weekly_credit_limit) : 500
  };
}

async function createSale(payload, openedBy, cashierId) {
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('La venta no contiene artículos.');
  }

  const benefitSettings = await getEmployeeBenefitSettings();

  const { data, error } = await supabase.rpc('process_sale', {
    p_branch_id: getCurrentBranchId(),
    p_client_type: payload.clientType || 'public',
    p_items: mapCartItems(payload.items),
    p_payment_method: payload.paymentMethod || 'efectivo',
    p_amount_received: payload.amountReceived != null
      ? Number(payload.amountReceived)
      : null,
    p_discount: Number(payload.discount) || 0,
    p_opened_by: openedBy || null,
    p_employee_id: payload.employeeId != null
      ? Number(payload.employeeId)
      : null,
    p_employee_sale_type: payload.employeeSaleType || null,
    p_employee_extra_payment: payload.employeeExtraPayment || null,
    p_benefit_enabled: benefitSettings.benefitEnabled,
    p_benefit_daily_amount: benefitSettings.benefitDailyAmount,
    p_weekly_credit_enabled: benefitSettings.weeklyCreditEnabled,
    p_weekly_credit_limit: benefitSettings.weeklyCreditLimit
  });

  must(error, 'No se pudo registrar la venta');

  // Salsas elegidas en mostrador (ver sales-renderer.js/showSauceSelector):
  // process_sale no conoce sale_item_modifiers, así que se ligan aparte una
  // vez que ya existen los sale_items reales, igual que
  // comandaAddItemWithModifiers hace para comandas, sin tocar el RPC (863
  // líneas, frágil). process_sale inserta un renglón por elemento de
  // p_items, en el mismo orden del arreglo (ver bucle FOR ... IN
  // jsonb_array_elements(p_items) en 20260815070100_process_sale_persist_benefit.sql),
  // así que a los sale_items recién creados, ordenados por id, les
  // corresponde -- en ese mismo orden -- cada elemento de payload.items.
  const itemsWithModifiers = payload.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => Array.isArray(item.modifierIds) && item.modifierIds.length > 0);

  if (itemsWithModifiers.length > 0) {
    const { data: createdItems, error: createdItemsErr } = await supabase.rpc('get_sale_items_with_modifiers', {
      p_branch_id: getCurrentBranchId(),
      p_sale_ids: [data.id]
    });
    if (createdItemsErr) {
      console.error('No se pudieron ligar las salsas elegidas:', createdItemsErr.message);
    } else {
      // set_sale_item_notes_and_modifiers (RPC) reemplaza el insert directo
      // a sale_item_modifiers (bloqueado por RLS desde 20260820010000);
      // valida que cada renglón sea de esta sucursal antes de ligar la salsa.
      for (const { item, index } of itemsWithModifiers) {
        const saleItem = createdItems[index];
        if (!saleItem) continue;
        const { error: modErr } = await supabase.rpc('set_sale_item_notes_and_modifiers', {
          p_branch_id: getCurrentBranchId(),
          p_sale_item_id: saleItem.id,
          p_notes: null,
          p_modifier_ids: item.modifierIds
        });
        if (modErr) console.error('No se pudieron guardar las salsas elegidas:', modErr.message);
      }
    }
  }

  // process_sale no recibe branch_id/cashier_user_id (branch_id ya se llena
  // solo por el DEFAULT de la columna); se completan aquí sin arriesgar la
  // función de cobro. Si esto falla no se revierte la venta ya cerrada,
  // solo queda sin "Atendió" en el ticket.
  if (cashierId != null) {
    const { error: updErr } = await supabase.rpc('set_sale_cashier', {
      p_branch_id: getCurrentBranchId(),
      p_sale_id: data.id,
      p_cashier_user_id: cashierId
    });
    if (updErr) console.error('No se pudo asociar el cajero a la venta:', updErr.message);
  }

  // Si el excedente del beneficio de empleado se fue a crédito de nómina,
  // process_sale ya lo sumó a employee_weekly_credit (usado por la pestaña
  // "Nómina semanal" de Asistencia); aquí además se registra en
  // payroll_deductions -- la fuente que usa el módulo de Nómina nuevo
  // (día de pago configurable, faltas, cierre semanal). Son dos libros que
  // reflejan el mismo hecho; no se revierte la venta si esto falla, ya se
  // cobró/comprometió el crédito y debe quedar registrada de todas formas.
  if (Number(data.credit_amount) > 0) {
    try {
      const payrollSettings = await getPayrollSettings();
      const { start, end } = getWeekRange(payrollSettings.dayNumber);
      const { error: dedErr } = await supabase.from('payroll_deductions').insert([{
        employee_name: data.employee_name,
        amount: Number(data.credit_amount),
        sale_id: data.id,
        reason: 'Excedente crédito nómina - venta empleado',
        status: 'pendiente',
        week_start: start,
        week_end: end,
        branch_id: getCurrentBranchId()
      }]);
      if (dedErr) console.error('No se pudo registrar la deducción de nómina:', dedErr.message);
    } catch (err) {
      console.error('No se pudo registrar la deducción de nómina:', err.message);
    }
  }

  return {
    id: data.id,
    folio: data.folio,
    employeeId: data.employee_id ?? payload.employeeId ?? null
  };
}
async function getSaleById(id) {
  const { data: sale, error } = await supabase.from('sales').select('*').eq('id', id).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(error, 'No se pudo obtener la venta');
  if (!sale) return null;
  const rawItems = await getSaleItemsWithModifiers(id);
  const items = await reattachModifierNames(rawItems);

  let employeeBenefitUsed = 0;
  let employeeCashExtra = 0;
  let employeeCreditExtra = 0;

  if (sale.employee_id) {
    const { data: consumption, error: consErr } = await supabase.rpc(
      'get_sale_employee_breakdown',
      { p_sale_id: id }
    );
    if (!consErr && consumption) {
      employeeBenefitUsed = Number(consumption.benefit_amount || 0);
      employeeCashExtra = Number(consumption.employee_paid || 0);
      employeeCreditExtra = Number(consumption.credit_amount || 0);
    }
  }

  // La tabla 'sales' ya no tiene columnas subtotal/discount/change_given
  // (solo 'total'); se recalculan aquí para el ticket impreso, que sí las
  // espera (ticket-renderer.js).
  const subtotal = (items || []).reduce((sum, it) => sum + Number(it.subtotal || 0), 0);
  const discount = Math.max(subtotal - Number(sale.total || 0), 0);
  const changeGiven = sale.payment_method === 'efectivo' && sale.amount_received != null
    ? Math.max(Number(sale.amount_received) - Number(sale.total || 0), 0)
    : 0;

  // Ticket completo: quién cobró (cashier_user_id -> users), qué empleado es
  // el cliente si aplica (sales.employee_id -> employees, el motor de
  // beneficio/crédito ya existente) y la sucursal.
  const [cashierRes, customerRes, branchRes] = await Promise.all([
    sale.cashier_user_id
      ? supabase.from('users').select('id, username, display_name:name').eq('id', sale.cashier_user_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    sale.employee_id
      ? supabase.from('employees').select('id, name, role').eq('id', sale.employee_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    sale.branch_id
      ? supabase.from('branches').select('id, name, address, phone').eq('id', sale.branch_id).maybeSingle()
      : Promise.resolve({ data: null, error: null })
  ]);
  must(cashierRes.error, 'No se pudo obtener el cajero de la venta');
  must(customerRes.error, 'No se pudo obtener el empleado cliente de la venta');
  must(branchRes.error, 'No se pudo obtener la sucursal de la venta');

  const employee = cashierRes.data
    ? { id: cashierRes.data.id, username: cashierRes.data.username, display_name: cashierRes.data.display_name }
    // Ventas anteriores a cashier_user_id solo tienen el texto libre opened_by.
    : (sale.opened_by ? { id: null, username: sale.opened_by, display_name: sale.opened_by } : null);

  const customer = customerRes.data
    ? { id: customerRes.data.id, display_name: customerRes.data.name, role: customerRes.data.role }
    : null;

  const branch = branchRes.data
    ? { id: branchRes.data.id, name: branchRes.data.name, address: branchRes.data.address, phone: branchRes.data.phone }
    : null;

  // Snapshot del beneficio diario ($100/día) tomado en el momento de la
  // venta; solo tiene sentido cuando el cliente es un empleado.
  const creditBefore = sale.employee_id ? Number(sale.employee_benefit_before ?? 0) : null;
  const creditAvailableAfter = sale.employee_id ? Number(sale.employee_benefit_after ?? 0) : null;

  return {
    ...sale,
    items,
    subtotal,
    discount,
    change_given: changeGiven,
    employeeBenefitUsed,
    employeeCashExtra,
    employeeCreditExtra,
    employee,
    customer,
    branch,
    credit_before: creditBefore,
    credit_available_after: creditAvailableAfter
  };
}
async function getAllSales(filters = {}) {
  let query = supabase.from('sales').select('*').eq('branch_id', getCurrentBranchId());
  if (filters.status) query = query.eq('status', filters.status);
  // Antes hardcodeaba "Xalapa = UTC-6" a mano (mismo patrón ya corregido en
  // getCorteResumen) -- unificado con localDayStartUtcIso/localDayEndUtcIso.
  if (filters.dateFrom) query = query.gte('created_at', localDayStartUtcIso(filters.dateFrom));
  if (filters.dateTo) query = query.lte('created_at', localDayEndUtcIso(filters.dateTo));
  query = query.order('id', { ascending: false });
  if (filters.limit) query = query.limit(Number(filters.limit));
  const { data, error } = await query;
  must(error, 'No se pudieron obtener las ventas');
  return data;
}
async function getEmployeeDailyConsumption(employeeId) {
  console.log('=== DEBUG CONSUMO EMPLEADO ===');
  console.log('employeeId recibido:', employeeId);

  if (!employeeId) {
    console.log('employeeId vacío');
    return 0;
  }

  // Pendiente: get_employee_daily_consumption todavía no recibe
  // p_branch_id (RPC "caja negra", ver 20260820060000_tmp_introspect_pending_rpcs.sql).
  // Mientras tanto, este select cierra la parte del hueco que sí se puede
  // cerrar sin tocar ese RPC: confirmar aquí que el empleado es de esta
  // sucursal antes de pedirle su consumo.
  const { data: emp, error: empErr } = await supabase
    .from('employees').select('id').eq('id', Number(employeeId)).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(empErr, 'No se pudo verificar el empleado');
  if (!emp) throw new Error('El empleado no pertenece a esta sucursal.');

  // IMPORTANTE: se usa el RPC (SECURITY DEFINER) y NO un select directo a
  // la tabla employee_consumption. La tabla tiene RLS que bloquea lecturas
  // directas del cliente de Supabase; el RPC corre con privilegios elevados
  // y es la única vía sancionada para leer este dato.
  const { data, error } = await supabase.rpc(
    'get_employee_daily_consumption',
    { p_employee_id: Number(employeeId) }
  );

  console.log('error Supabase:', error);
  console.log('data Supabase (RPC):', data);

  must(
    error,
    'No se pudo consultar el consumo diario del empleado'
  );

  const consumed = Number(data || 0);

  console.log('CONSUMO TOTAL:', consumed);
  console.log('==============================');

  return consumed;
}
// Resumen de artículos vendidos (ventas completadas) en un rango de fechas,
// sin límite de filas — usado por el reporte/CSV de "productos".
async function getProductsSummary(dateFrom, dateTo) {
  const fromTs = localDayStartUtcIso(dateFrom);
  const toTs = localDayEndUtcIso(dateTo);
  const { data: items, error } = await supabase.rpc('get_sale_items_summary', {
    p_branch_id: getCurrentBranchId(),
    p_from: fromTs,
    p_to: toTs
  });
  must(error, 'No se pudo obtener el resumen de productos');
  const byProduct = {};
  (items || []).forEach((it) => {
    if (!byProduct[it.name]) byProduct[it.name] = { name: it.name, unidades: 0, total: 0 };
    byProduct[it.name].unidades += Number(it.quantity || 0);
    byProduct[it.name].total += Number(it.subtotal || 0);
  });
  return Object.values(byProduct).sort((a, b) => b.total - a.total);
}

async function markSalePrinted(id) {
  const { error } = await supabase.rpc('mark_sale_printed', { p_branch_id: getCurrentBranchId(), p_sale_id: id });
  must(error, 'No se pudo marcar el ticket como impreso');
  return true;
}

// ==========================================================================
// 4B. REALTIME — alerta de cocina para comandas nuevas
// ==========================================================================
// Suscripción a nivel de tabla ("sales" completa) en vez de "sale_items":
// una comanda nueva de mesa dispara UN insert en "sales" (status 'abierta'),
// y una venta de mostrador/llevar (web o esta misma app) dispara UN insert
// en "sales" (status 'completada') vía process_sale. Los artículos (N filas
// en sale_items) nunca generan el evento, así que no hay que debounced por
// cantidad de artículos: hay como máximo un evento por comanda nueva.
//
// Requiere que la tabla public.sales esté agregada a la publicación
// "supabase_realtime" en Supabase (Database > Replication) y que exista una
// policy de SELECT para el rol anon (ya existe: sales_select_anon) — RLS se
// aplica también a los eventos de Realtime.
function subscribeToNewSales(onInsert, onStatusChange) {
  return supabase
    .channel('sales-inserts')
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'sales', filter: `branch_id=eq.${getCurrentBranchId()}` },
      (payload) => onInsert(payload.new)
    )
    .subscribe((status, err) => {
      if (typeof onStatusChange === 'function') {
        onStatusChange(status === 'SUBSCRIBED', status, err);
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('Realtime (sales) desconectado:', status, err ? err.message : '');
      } else if (status === 'SUBSCRIBED') {
        console.log('Realtime (sales) activo: escuchando comandas nuevas.');
      } else if (status === 'CLOSED') {
        console.log('Realtime (sales) cerrado.');
      }
    });
}

// ==========================================================================
// 5. COMANDAS (mesas)
// ==========================================================================
async function getSettingValue(key, fallback) {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .eq('branch_id', getCurrentBranchId())
    .maybeSingle();
  if (error || !data) return fallback;
  return data.value;
}

async function getTables() {
  const tableCount = Number(await getSettingValue('table_count', 10)) || 10;
  const { data: openSales, error } = await supabase.from('sales').select('*')
    .eq('status', 'abierta').eq('branch_id', getCurrentBranchId()).not('table_number', 'is', null);
  must(error, 'No se pudieron obtener las mesas');
  const byTable = {};
  (openSales || []).forEach((s) => (byTable[s.table_number] = s));
  const tables = [];
  for (let i = 1; i <= tableCount; i++) {
    const sale = byTable[i];
    tables.push({
      number: i,
      status: sale ? 'ocupada' : 'libre',
      saleId: sale ? sale.id : null,
      total: sale ? sale.total : 0,
      openedAt: sale ? sale.created_at : null,
      openedBy: sale ? sale.opened_by : null
    });
  }
  return tables;
}

async function openTable(tableNumber, openedBy) {
  const { data, error } = await supabase.rpc('comanda_open_table', {
    p_branch_id: getCurrentBranchId(),
    p_table_number: tableNumber,
    p_opened_by: openedBy || null
  });
  must(error, 'No se pudo abrir la mesa');
  return { id: data };
}

// Trae cada renglón de sale_items junto con sus modificadores (salsas)
// elegidos, si los tiene -- sale_item_modifiers(modifier_id). Usado tanto
// por la comanda de mesa como por la de para llevar para poder pintar
// "• {salsa}" bajo el producto.
//
// OJO: ya NO se embebe modifiers(id, name) aquí -- desde que products/
// modifiers quedaron cerrados por completo para anon (20260820080000), un
// join embebido de PostgREST hacia una tabla con RLS que deniega SELECT
// devuelve null en vez de tronar, así que el nombre de la salsa se perdía
// en silencio. reattachModifierNames() (abajo) reconstruye la MISMA forma
// que tenían estos objetos antes (sale_item_modifiers[].modifiers.name),
// resolviendo el nombre vía getModifiers() (ahora RPC), para no tener que
// tocar ticket-renderer.js/history-renderer.js/kds-renderer.js que ya
// esperan esa forma.
// sale_items/sale_item_modifiers ya no admiten SELECT directo para anon
// (20260820025000 -- misma fuga cerrada que products/modifiers). Reemplaza
// el patrón `.from('sale_items').select('*, sale_item_modifiers(id,
// modifier_id))').eq/in('sale_id', ...)` por la RPC equivalente, que
// devuelve exactamente la misma forma (json con todas las columnas de
// sale_items + sale_item_modifiers como array anidado).
async function getSaleItemsWithModifiers(saleIds) {
  const ids = Array.isArray(saleIds) ? saleIds : [saleIds];
  if (ids.length === 0) return [];
  const { data, error } = await supabase.rpc('get_sale_items_with_modifiers', {
    p_branch_id: getCurrentBranchId(),
    p_sale_ids: ids
  });
  must(error, 'No se pudieron obtener los artículos de la venta');
  return data || [];
}

async function getModifierNameMap() {
  const mods = await getModifiers();
  return new Map(mods.map((m) => [m.id, m.name]));
}

async function reattachModifierNames(items) {
  const nameMap = await getModifierNameMap();
  return (items || []).map((it) => ({
    ...it,
    sale_item_modifiers: (it.sale_item_modifiers || []).map((sim) => ({
      ...sim,
      modifiers: nameMap.has(sim.modifier_id) ? { id: sim.modifier_id, name: nameMap.get(sim.modifier_id) } : null
    }))
  }));
}

async function getOpenSaleByTable(tableNumber) {
  const { data: sale, error } = await supabase.from('sales').select('*')
    .eq('status', 'abierta').eq('table_number', tableNumber).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(error, 'No se pudo obtener la mesa');
  if (!sale) return null;
  const items = await getSaleItemsWithModifiers(sale.id);
  return { ...sale, items: await reattachModifierNames(items) };
}

// Pedidos "para llevar": misma comanda que una mesa (sale_items, cobro,
// cancelación), sin límite de una sola comanda abierta a la vez (a
// diferencia de una mesa, se puede abrir un pedido para llevar nuevo aunque
// ya haya otros en curso). Se filtra por client_type (no por table_number)
// porque tanto el escritorio (comanda_open_takeout, client_type 'Para
// llevar') como la web (process_sale, client_type 'Llevar') abren estos
// pedidos, y ambas fuentes ya dejan table_number en NULL.
// select('*') ya trae is_delivery, customer_name, customer_phone,
// delivery_address, driver_name, delivery_fee y delivery_status (columnas
// agregadas por comanda_set_delivery, ver wing-house-web/supabase/migrations
// /0004_delivery_orders.sql): la web las llena al crear un pedido a
// domicilio, y esta pantalla las lee para pintar la tarjeta 🛵. No se filtra
// por is_delivery: los pedidos "para llevar" normales (sin domicilio) deben
// listarse igual.
async function getOpenTakeoutOrders() {
  const { data, error } = await supabase.from('sales').select('*')
    .eq('status', 'abierta').eq('branch_id', getCurrentBranchId())
    .in('client_type', ['Para llevar', 'Llevar', 'PARA LLEVAR'])
    .order('created_at', { ascending: false });
  must(error, 'No se pudieron obtener los pedidos para llevar');
  return data;
}

async function openTakeoutOrder(openedBy) {
  const { data, error } = await supabase.rpc('comanda_open_takeout', {
    p_branch_id: getCurrentBranchId(),
    p_opened_by: openedBy || null
  });
  must(error, 'No se pudo abrir el pedido para llevar');
  return { id: data };
}

// Cambia solo el estado de entrega (pendiente -> en_camino -> entregado).
// No toca driver_name ni el resto de los datos de domicilio: esos se
// capturan una sola vez desde la web (comanda_set_delivery) o al asignar
// repartidor desde el escritorio (comandaAssignDriver); esta función solo
// avanza el estado.
// Al llegar a 'entregado' también cierra la venta (status = 'completada'):
// process_sale la insertó como 'abierta' para que fuera visible aquí
// mientras iba en camino (ver 20260816010000_process_sale_delivery_open.sql).
// payment_status pasa a 'dinero_con_repartidor' en ese mismo instante: es
// cuando el repartidor cobra en la puerta del cliente (comida + envío), y el
// dinero existe pero todavía está en la calle, no en el cajón. NUNCA debe
// quedar en 'pagado_en_caja' aquí -- eso solo lo pone liquidateDriverSales
// cuando el repartidor de verdad regresa el efectivo (ver getCorteResumen,
// que excluye 'dinero_con_repartidor' del corte para no inflar el cajón).
async function comandaSetDeliveryStatus(saleId, status) {
  if (status !== 'en_camino' && status !== 'entregado') {
    throw new Error(`Estado de entrega inválido: ${status}`);
  }
  const { error } = await supabase.rpc('comanda_update_delivery_status', {
    p_branch_id: getCurrentBranchId(),
    p_sale_id: saleId,
    p_status: status
  });
  must(error, 'No se pudo actualizar el estado de entrega');
  return true;
}

// Asigna un repartidor estructurado (tabla drivers) a un pedido a domicilio
// y lo manda a "en camino" (comanda_assign_driver, SECURITY DEFINER: valida
// que el pedido sea is_delivery y que no tenga repartidor ya asignado, y
// ajusta el total solo por la diferencia del envío para no duplicar el
// cobro si la web ya lo había cargado). No toca payment_status: el
// repartidor sale con la comida, todavía no ha cobrado nada.
async function comandaAssignDriver(saleId, driverId, deliveryFee) {
  const { data, error } = await supabase.rpc('comanda_assign_driver', {
    p_branch_id: getCurrentBranchId(),
    p_sale_id: saleId,
    p_driver_id: driverId,
    p_delivery_fee: Number(deliveryFee) || 0
  });
  must(error, 'No se pudo asignar el repartidor');
  return data;
}

// Repartidores activos, para el selector de "Asignar repartidor" en Comandas
// y el panel de liquidación en Ajustes.
async function getDrivers() {
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('branch_id', getCurrentBranchId())
    .eq('active', true)
    .order('name');
  must(error, 'No se pudieron obtener los repartidores');
  return data || [];
}

async function createDriver(name, phone) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('El nombre del repartidor es obligatorio.');
  const { data, error } = await supabase.rpc('create_driver', {
    p_branch_id: getCurrentBranchId(),
    p_name: cleanName,
    p_phone: phone || null
  });
  must(error, 'No se pudo crear el repartidor');
  return data;
}

// Dinero que los repartidores traen en la calle en este momento: pedidos ya
// entregados (el cliente ya pagó) pero que todavía no se liquidan en caja.
// Se agrupa en JS (igual que getCorteResumen) porque supabase-js no hace
// GROUP BY directo sin una vista o RPC aparte.
async function getPendingDriverMoney() {
  const { data, error } = await supabase
    .from('sales')
    .select('id, total, delivery_fee, driver_id, drivers(name)')
    .eq('branch_id', getCurrentBranchId())
    .eq('payment_status', 'dinero_con_repartidor')
    .not('driver_id', 'is', null);
  must(error, 'No se pudo obtener el dinero pendiente de repartidores');

  const byDriver = {};
  (data || []).forEach((s) => {
    const total = Number(s.total) || 0;
    const fee = Number(s.delivery_fee) || 0;
    if (!byDriver[s.driver_id]) {
      byDriver[s.driver_id] = {
        driverId: s.driver_id,
        driverName: s.drivers ? s.drivers.name : 'Repartidor',
        pedidos: 0,
        aRegresar: 0
      };
    }
    byDriver[s.driver_id].pedidos += 1;
    byDriver[s.driver_id].aRegresar += Math.max(total - fee, 0);
  });

  return Object.values(byDriver);
}

// Caja recibe el efectivo de la comida que trae el repartidor (liquidate_driver_sales,
// SECURITY DEFINER: una sola sentencia UPDATE, atómica). El repartidor se
// queda con el envío -- por eso el total liquidado es total - delivery_fee,
// no el total completo.
async function liquidateDriverSales(driverId) {
  const { data, error } = await supabase.rpc('liquidate_driver_sales', {
    p_branch_id: getCurrentBranchId(),
    p_driver_id: driverId
  });
  must(error, 'No se pudo liquidar al repartidor');
  return data;
}

async function getSalesByPaymentStatus(status) {
  const { data, error } = await supabase
    .from('sales')
    .select('*')
    .eq('branch_id', getCurrentBranchId())
    .eq('payment_status', status)
    .order('created_at', { ascending: false });
  must(error, 'No se pudieron obtener las ventas por estado de pago');
  return data || [];
}

async function updateSalePaymentStatus(saleId, status) {
  const VALID = ['pendiente', 'pagado_en_caja', 'dinero_con_repartidor', 'liquidado'];
  if (!VALID.includes(status)) throw new Error(`Estado de pago inválido: ${status}`);
  const { error } = await supabase.rpc('update_sale_payment_status', {
    p_branch_id: getCurrentBranchId(),
    p_sale_id: saleId,
    p_status: status
  });
  must(error, 'No se pudo actualizar el estado de pago');
  return true;
}

async function getOpenSaleById(saleId) {
  const { data: sale, error } = await supabase.from('sales').select('*').eq('id', saleId).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(error, 'No se pudo obtener el pedido');
  if (!sale || sale.status !== 'abierta') return null;
  const items = await getSaleItemsWithModifiers(sale.id);
  return { ...sale, items: await reattachModifierNames(items) };
}

async function comandaAddItem(saleId, item) {
  // Con salsa(s) elegidas: comanda_add_item no soporta modificadores (fue
  // pensada solo para producto+cantidad), así que este caso se resuelve
  // aparte con inserción directa en sale_items + sale_item_modifiers, sin
  // tocar el RPC para no romper el flujo normal sin modificadores.
  if (Array.isArray(item.modifierIds) && item.modifierIds.length > 0) {
    return comandaAddItemWithModifiers(
      saleId,
      item.id ?? item.productId ?? item.ref_id,
      item.quantity,
      item.modifierIds,
      item.notes || null
    );
  }

  const { error } = await supabase.rpc('comanda_add_item', {
    p_branch_id: getCurrentBranchId(),
    p_sale_id: saleId,
    p_ref_id: item.id ?? item.ref_id ?? null,
    p_item_type: item.itemType || item.item_type || 'product',
    p_name: item.name,
    p_unit_price: Number(item.price ?? item.unit_price) || 0,
    p_quantity: Number(item.quantity) || 1
  });
  must(error, 'No se pudo agregar el artículo');
  const { data: sale, error: selErr } = await supabase.from('sales').select('*').eq('id', saleId).eq('branch_id', getCurrentBranchId()).single();
  must(selErr);
  return sale;
}

// Agrega un producto con modificadores (p.ej. ALITAS + salsa BBQ) a una
// comanda abierta. A diferencia de comanda_add_item, siempre inserta un
// renglón nuevo en sale_items (no intenta fusionar cantidad con un renglón
// existente del mismo producto): dos elecciones de salsa distintas deben
// verse como líneas separadas en el ticket. El descuento de inventario de
// cada salsa (modifiers.qty_needed * cantidad) lo hace
// trg_sale_item_modifiers_after_insert automáticamente al insertar en
// sale_item_modifiers -- aquí no se toca inventory directamente.
async function comandaAddItemWithModifiers(saleId, productId, qty, modifierIds, notes) {
  // products ya no admite SELECT directo para anon (20260820000012) --
  // se resuelve vía la misma RPC que usa getAllProducts().
  const products = await getAllProducts();
  const product = products.find((p) => p.id === productId);
  if (!product) throw new Error('Producto no encontrado');

  const quantity = Math.max(1, Number(qty) || 1);
  const unitPrice = Number(product.price) || 0;

  const { data: sale, error } = await supabase.rpc('comanda_add_item_with_modifiers', {
    p_branch_id: getCurrentBranchId(),
    p_sale_id: saleId,
    p_ref_id: productId,
    p_item_type: 'product',
    p_name: product.name,
    p_unit_price: unitPrice,
    p_quantity: quantity,
    p_modifier_ids: modifierIds && modifierIds.length ? modifierIds : null,
    p_notes: notes || null
  });
  must(error, 'No se pudo agregar el artículo');
  return sale;
}

// Modificadores (p.ej. salsas de Alitas/Boneless). groupName es opcional:
// sin él, trae todos los modificadores de todos los grupos (usado por la
// pantalla de administración de catálogo).
// modifiers ya no admite SELECT/UPDATE directo para anon (confirmado en
// prod -- solo deny_anon_direct) -- se resuelve vía get_modifiers_by_branch
// (RPC ya existente desde 20260820000011, misma que usa ModifierBottomSheet
// en wing-house-web). El !inner(inventory) original filtraba modificadores
// sin insumo ligado y traía stock/unit -- se replica con getAllInventory()
// (esa tabla sigue abierta a SELECT directo hoy) más un join en JS.
async function getModifiers(groupName) {
  const [{ data, error }, inventory] = await Promise.all([
    supabase.rpc('get_modifiers_by_branch', { p_branch_id: getCurrentBranchId() }),
    getAllInventory()
  ]);
  must(error, 'No se pudieron obtener los modificadores');
  const inventoryById = new Map(inventory.map((i) => [i.id, i]));
  const withInventory = (data || [])
    .filter((m) => m.inventory_id != null && inventoryById.has(m.inventory_id))
    .map((m) => {
      const inv = inventoryById.get(m.inventory_id);
      return { ...m, inventory: { stock: inv.stock, unit: inv.unit } };
    });
  const filtered = groupName ? withInventory.filter((m) => m.group_name === groupName) : withInventory;
  return filtered.sort((a, b) => a.name.localeCompare(b.name));
}

async function updateModifier(id, data) {
  // Cuánto de su insumo consume una porción, en la unidad propia de ese
  // insumo (ver inventory.unit) -- nunca se convierte, igual que
  // recipes.quantity_needed (20260819090200_salsa_stock_real.sql).
  const qtyNeeded = data.qty_needed !== undefined ? Math.max(0.01, Number(data.qty_needed) || 60) : null;

  // OJO: update_modifier (RPC, 20260820000012) hace `price_extra =
  // p_price_extra` SIN COALESCE (a diferencia de name/inventory_id/
  // qty_needed, que sí usan COALESCE contra el valor NULL "no tocar") --
  // mandar NULL aquí borraría el precio extra aunque el llamador no lo haya
  // tocado (el único caller real, catalog-renderer.js, nunca manda
  // price_extra). Se preserva el valor actual explícitamente en ese caso.
  let priceExtra;
  if (data.price_extra !== undefined) {
    priceExtra = data.price_extra != null ? Number(data.price_extra) : null;
  } else {
    const { data: currentRows, error: curErr } = await supabase.rpc('get_modifiers_by_branch', { p_branch_id: getCurrentBranchId() });
    must(curErr, 'No se pudo leer el modificador actual');
    const current = (currentRows || []).find((m) => m.id === id);
    priceExtra = current ? current.price_extra : null;
  }

  const { data: row, error } = await supabase.rpc('update_modifier', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_name: data.name !== undefined ? data.name : null,
    p_inventory_id: data.inventory_id !== undefined ? data.inventory_id : null,
    p_price_extra: priceExtra,
    p_qty_needed: qtyNeeded
  });
  must(error, 'No se pudo actualizar el modificador');
  return row;
}

// Qué productos tienen qué grupo de modificadores asignado (p.ej. ALITAS ->
// 'Salsas'). Se trae completo de una vez -- son pocas filas -- para que el
// catálogo de comandas pueda decidir en el cliente si abrir el selector de
// salsa antes de agregar un producto al carrito.
// product_modifier_groups no tiene branch_id propio (se acota por
// product_id -- ver 20260820000013), y nunca admitió SELECT directo con
// garantía de sucursal para anon (el hallazgo "Arq." de la auditoría
// original: ni siquiera validaba que productId fuera de esta sucursal).
async function getAllProductModifierGroups() {
  const { data, error } = await supabase.rpc('get_product_modifier_groups_by_branch', { p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudieron obtener los grupos de modificadores por producto');
  return data || [];
}

async function setProductModifierGroup(productId, groupName, enabled, qty = 1) {
  const { error } = await supabase.rpc('set_product_modifier_group', {
    p_branch_id: getCurrentBranchId(),
    p_product_id: productId,
    p_group_name: groupName,
    p_enabled: !!enabled,
    p_qty: Math.max(1, Number(qty) || 1)
  });
  must(error, 'No se pudo actualizar el grupo de modificadores');
  return true;
}

// ==========================================================================
// COMBOS -- product_components: producto -> producto (p.ej. PROMO 40
// ALITAS incluye 2x PAPA FRANCESA). El insumo directo de un combo (40 pzs
// de ALITA) NO va aquí -- va en `recipes` como cualquier producto, así
// reutiliza su trigger de descuento/reposición y su validación de stock
// (ver 20260819090100_combos_schema.sql).
// ==========================================================================
// product_components ya no admite SELECT/INSERT/DELETE directo para anon
// (confirmado en prod -- solo deny_anon_direct) -- se resuelve vía las RPC
// de 20260820000013.
async function getComponentsForProduct(productId) {
  const { data, error } = await supabase.rpc('get_components_for_product', {
    p_branch_id: getCurrentBranchId(),
    p_product_id: productId
  });
  must(error, 'No se pudieron obtener los componentes del combo');
  return data || [];
}

// Reemplaza por completo los componentes de un combo con la lista recibida:
// [{ component_product_id, qty }]
async function setComponentsForProduct(productId, rows) {
  const clean = (rows || [])
    .filter((r) => r.component_product_id && Number(r.component_product_id) !== Number(productId) && Number(r.qty) > 0)
    .map((r) => ({ component_product_id: Number(r.component_product_id), qty: Number(r.qty) }));

  const { data, error } = await supabase.rpc('set_components_for_product', {
    p_branch_id: getCurrentBranchId(),
    p_product_id: productId,
    p_rows: clean
  });
  must(error, 'No se pudieron guardar los componentes del combo');
  return data;
}

// Todos los combos del catálogo de una vez -- usado por catalog-renderer.js
// para marcar con el badge "COMBO" los productos que tienen componentes.
async function getAllProductComponents() {
  const { data, error } = await supabase.rpc('get_all_product_components_by_branch', { p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudieron obtener los componentes de combos');
  return data || [];
}

async function comandaUpdateItemQty(itemId, quantity) {
  const p_item_id = Number(itemId);
  const p_quantity = Number(quantity);
  if (!Number.isFinite(p_item_id) || !Number.isFinite(p_quantity)) {
    console.error('comandaUpdateItemQty recibió valores no numéricos', { itemId, quantity });
    throw new Error('ID de artículo o cantidad inválidos.');
  }
  // comanda_update_item_qty ya devuelve la venta actualizada (row_to_json),
  // no un id: no hay que volver a consultarla.
  const { data: sale, error } = await supabase.rpc('comanda_update_item_qty', {
    p_branch_id: getCurrentBranchId(),
    p_item_id,
    p_quantity
  });
  must(error, 'No se pudo actualizar la cantidad');
  return sale;
}

async function comandaRemoveItem(itemId) {
  // comanda_remove_item también devuelve la venta actualizada directamente.
  const { data: sale, error } = await supabase.rpc('comanda_remove_item', {
    p_branch_id: getCurrentBranchId(),
    p_item_id: itemId
  });
  must(error, 'No se pudo quitar el artículo');
  return sale;
}

async function comandaCloseTable(saleId, payload, openedBy, cashierId) {
  const { data, error } = await supabase.rpc('close_table', {
    p_branch_id: getCurrentBranchId(),
    p_sale_id: saleId,
    p_discount: Number(payload.discount) || 0,
    p_payment_method: payload.paymentMethod || 'efectivo',
    p_amount_received: payload.amountReceived != null ? Number(payload.amountReceived) : null,
    p_opened_by: openedBy || null
  });
  must(error, 'No se pudo cerrar la mesa');

  if (cashierId != null) {
    const { error: updErr } = await supabase.rpc('set_sale_cashier', {
      p_branch_id: getCurrentBranchId(),
      p_sale_id: data.id,
      p_cashier_user_id: cashierId
    });
    if (updErr) console.error('No se pudo asociar el cajero a la mesa:', updErr.message);
  }

  return { id: data.id, folio: data.folio };
}

async function comandaCancelTable(saleId) {
  const { data: sale, error: selErr } = await supabase.from('sales').select('status').eq('id', saleId).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(selErr);
  if (!sale || sale.status !== 'abierta') throw new Error('Solo se puede cancelar una mesa abierta.');
  const { error } = await supabase.rpc('cancel_table', { p_sale_id: saleId, p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudo cancelar la mesa');
  return { cancelled: true };
}

// ==========================================================================
// 5B. KDS (Kitchen Display System) — TV de cocina por HDMI, sin login.
// ==========================================================================
// No hay una tabla "orders" aparte: cada comanda/venta YA es una fila de
// `sales` (mesa, para llevar, mostrador, y también lo que inserta
// wing-house-web, que no se toca). Se le agregaron 4 columnas a `sales`
// (kds_status/kds_started_at/kds_ready_at/kds_delivered_at, ver
// supabase/migrations/20260818040000_kds_status.sql) para que el KDS sea
// solo una vista distinta de los mismos datos, no un sistema paralelo que
// se pueda desincronizar.
const KDS_STATUSES = ['nueva', 'en_preparacion', 'lista', 'entregada'];
const KDS_TIMESTAMP_COLUMN = {
  en_preparacion: 'kds_started_at',
  lista: 'kds_ready_at',
  entregada: 'kds_delivered_at'
};

// Todo lo que la cocina todavía no entregó, con sus artículos. Se excluyen
// las canceladas (canceladas antes de cocinar no deben seguir pidiendo que
// se cocinen) aunque su kds_status nunca se haya tocado.
async function getKdsOrders() {
  const { data: sales, error } = await supabase
    .from('sales')
    .select('id, table_number, client_type, folio, status, created_at, kds_status, kds_started_at, kds_ready_at, is_delivery, delivery_fee, driver_name, total')
    .eq('branch_id', getCurrentBranchId())
    .neq('kds_status', 'entregada')
    .neq('status', 'cancelada')
    .order('created_at', { ascending: true });
  must(error, 'No se pudieron obtener las órdenes de cocina');
  if (!sales || sales.length === 0) return [];

  const items = await getSaleItemsWithModifiers(sales.map((s) => s.id));

  // modifiers y product_components ya no se pueden embeber en el select de
  // arriba (RLS los cierra para anon desde 20260820080000) -- se resuelven
  // aparte, una sola vez, vía RPC de solo lectura de esta sucursal.
  const modifierNameMap = await getModifierNameMap();

  // Combos: si el ref_id de un renglón tiene componentes (ver
  // product_components/PARTE del comentario en 20260819090100_combos_schema.sql),
  // cocina necesita ver "+ 2x Papa Francesa" bajo el combo, no solo el
  // nombre de la promo -- la cantidad mostrada ya viene multiplicada por la
  // cantidad vendida del renglón.
  const { data: allComponents, error: compErr } = await supabase.rpc('get_all_product_components_by_branch', {
    p_branch_id: getCurrentBranchId()
  });
  must(compErr, 'No se pudieron obtener los componentes de combo para cocina');
  const componentsByProduct = {};
  (allComponents || []).forEach((c) => {
    if (!componentsByProduct[c.parent_product_id]) componentsByProduct[c.parent_product_id] = [];
    componentsByProduct[c.parent_product_id].push({ name: c.component_name, qty: Number(c.qty) || 0 });
  });

  const itemsBySale = {};
  (items || []).forEach((it) => {
    if (!itemsBySale[it.sale_id]) itemsBySale[it.sale_id] = [];
    const quantity = Number(it.quantity) || 0;
    const modifiers = (it.sale_item_modifiers || [])
      .map((sim) => modifierNameMap.get(sim.modifier_id))
      .filter(Boolean);
    const components = (componentsByProduct[it.ref_id] || [])
      .map((c) => ({ name: c.name, quantity: c.qty * quantity }));
    itemsBySale[it.sale_id].push({ name: it.name, quantity, notes: it.notes || null, modifiers, components });
  });

  return sales.map((s) => ({
    id: s.id,
    tableNumber: s.table_number,
    clientType: s.client_type,
    folio: s.folio,
    createdAt: s.created_at,
    kdsStatus: s.kds_status,
    kdsStartedAt: s.kds_started_at,
    kdsReadyAt: s.kds_ready_at,
    isDelivery: !!s.is_delivery,
    deliveryFee: Number(s.delivery_fee) || 0,
    driverName: s.driver_name || null,
    total: Number(s.total) || 0,
    items: itemsBySale[s.id] || []
  }));
}

async function updateKdsStatus(saleId, status) {
  if (!KDS_STATUSES.includes(status)) throw new Error(`Estado de KDS inválido: ${status}`);
  // update_kds_status (RPC) ya reproduce esta misma regla del lado del
  // servidor -- ver 20260820020000_rpc_branch_id_core_sales.sql -- incluida
  // la columna de timestamp por estado y el cierre automático de pedidos
  // 'Llevar' al llegar a 'entregada'.
  const { error } = await supabase.rpc('update_kds_status', {
    p_branch_id: getCurrentBranchId(),
    p_sale_id: saleId,
    p_status: status
  });
  must(error, 'No se pudo actualizar el estado de cocina');
  return true;
}

// Un solo canal para altas/cambios de sales y de sale_items (agregar/quitar
// un artículo a una mesa ya abierta también debe refrescar la TV). El
// llamador (main.js) simplemente vuelve a pedir getKdsOrders() completo en
// cada evento -- mismo patrón simple que subscribeToNewSales, sin intentar
// aplicar parches incrementales del lado del cliente.
// sale_items no tiene columna branch_id propia (hereda la sucursal de su
// venta vía sale_id), así que postgres_changes no puede filtrarla del lado
// del servidor -- Realtime solo filtra por columnas de la misma tabla. Con
// esto, el evento de "se agregó un renglón" de otra sucursal SÍ llega a
// este canal (aunque getKdsOrders(), ya filtrado por sucursal, ignore el
// contenido y solo lo use como señal de "vuelve a pedir"). Queda
// documentado como deuda -- ver auditoría A6 -- la solución completa es
// desnormalizar branch_id a sale_items o mover este refresco a un canal
// broadcast propio por sucursal.
function subscribeToKdsChanges(onChange) {
  return supabase
    .channel('kds-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sales', filter: `branch_id=eq.${getCurrentBranchId()}` }, onChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sale_items' }, onChange)
    .subscribe();
}

// ==========================================================================
// 6. INVENTARIO
// ==========================================================================
async function getAllInventory() {
  const { data, error } = await supabase.from('inventory').select('*').eq('branch_id', getCurrentBranchId()).order('name');
  must(error, 'No se pudo obtener el inventario');
  return data;
}

async function createInventoryItem(data, user = null) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('El nombre del insumo es obligatorio.');
  const initialStock = Number(data.stock) || 0;
  if (initialStock < 0) throw new Error('La existencia inicial no puede ser negativa.');

  const { data: row, error } = await supabase.rpc('create_inventory_item', {
    p_branch_id: getCurrentBranchId(),
    p_name: name,
    p_category: data.category || null,
    p_unit: data.unit || 'pz',
    p_stock: initialStock,
    p_min_stock: Number(data.min_stock) || 0,
    p_cost_per_unit: Number(data.cost_per_unit) || 0,
    p_created_by: user
  });
  must(error, 'No se pudo crear el insumo');
  return row;
}

async function updateInventoryItem(id, data, user = null) {
  const name = String(data.name || '').trim();
  if (!name) throw new Error('El nombre del insumo es obligatorio.');

  const newStock = Number(data.stock) || 0;
  if (newStock < 0) throw new Error('La existencia no puede ser negativa.');

  const { data: row, error } = await supabase.rpc('update_inventory_item', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_name: name,
    p_category: data.category || null,
    p_unit: data.unit || 'pz',
    p_stock: newStock,
    p_min_stock: Number(data.min_stock) || 0,
    p_cost_per_unit: Number(data.cost_per_unit) || 0,
    p_created_by: user
  });
  must(error, 'No se pudo actualizar el insumo');
  return row;
}

async function removeInventoryItem(id) {
  const { error } = await supabase.rpc('remove_inventory_item', { p_branch_id: getCurrentBranchId(), p_id: id });
  must(error, 'No se pudo eliminar el insumo');
  return { deleted: true };
}

// Agrega existencia a un insumo ya existente (compra, ajuste) sin pasar por
// el modal de edición completo. Registra el movimiento y, opcionalmente,
// actualiza el costo por unidad si llega uno nuevo.
async function addInventoryStock(id, data, user = null) {
  const quantity = Number(data.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('La cantidad a agregar debe ser mayor que cero.');
  }

  const hasCost = data.cost_per_unit !== undefined && data.cost_per_unit !== null && data.cost_per_unit !== '';

  const { data: row, error } = await supabase.rpc('add_inventory_stock', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_quantity: quantity,
    p_cost_per_unit: hasCost ? Number(data.cost_per_unit) || 0 : null,
    p_reason: data.reason || 'Compra',
    p_created_by: user
  });
  must(error, 'No se pudo agregar la existencia');
  return row;
}

async function getInventoryMovements(insumoId) {
  const { data, error } = await supabase
    .from('inventory_movements')
    .select('*')
    .eq('insumo_id', insumoId)
    .order('created_at', { ascending: false })
    .limit(200);
  must(error, 'No se pudo obtener el historial del insumo');
  return data;
}

async function checkLowStockInventory() {
  const { data, error } = await supabase
    .from('inventory')
    .select('*')
    .eq('branch_id', getCurrentBranchId())
    .order('name');
  must(error, 'No se pudo revisar el stock mínimo');
  return (data || []).filter((i) => Number(i.stock) <= Number(i.min_stock));
}

// ==========================================================================
// 6.1 RECETAS (liga productos del catálogo con los insumos que consumen)
// ==========================================================================
// recipes ya no admite SELECT/INSERT/DELETE directo para anon (mismo
// motivo que product_components -- ver 20260820000013). Ninguna de estas
// RPC devuelve el embed `inventory:insumo_id(...)` anidado que traía el
// select viejo -- devuelven columnas planas (insumo_name/insumo_unit/...);
// donde algún llamador seguía esperando `.inventory.x` anidado, se
// reconstruye aquí mismo para no tocar catalog-renderer.js/common.js.
async function getRecipesForProduct(productId) {
  const { data, error } = await supabase.rpc('get_recipes_for_product', {
    p_branch_id: getCurrentBranchId(),
    p_product_id: productId
  });
  must(error, 'No se pudo obtener la receta del producto');
  return data;
}

// Reemplaza por completo la receta de un producto con la lista recibida:
// [{ insumo_id, quantity_needed }]
async function setRecipesForProduct(productId, rows) {
  const clean = (rows || [])
    .filter((r) => r.insumo_id && Number(r.quantity_needed) > 0)
    .map((r) => ({ insumo_id: Number(r.insumo_id), quantity_needed: Number(r.quantity_needed) }));

  const { data, error } = await supabase.rpc('set_recipes_for_product', {
    p_branch_id: getCurrentBranchId(),
    p_product_id: productId,
    p_rows: clean
  });
  must(error, 'No se pudo guardar la receta');
  return data;
}

// Costo real de un producto según su receta (suma de insumo.cost_per_unit * quantity_needed).
async function getRecipeCost(productId) {
  const { data, error } = await supabase.rpc('get_recipe_cost', {
    p_branch_id: getCurrentBranchId(),
    p_product_id: productId
  });
  must(error, 'No se pudo calcular el costo de receta');
  return data;
}

// Todas las recetas con la existencia/mínimo actual del insumo y el nombre
// del producto -- una sola consulta para que catalog/sales/comandas-renderer
// calculen el semáforo de disponibilidad (verde/amarillo/rojo/sin receta)
// sin pedir producto por producto.
async function getAllRecipesWithStock() {
  const { data, error } = await supabase.rpc('get_all_recipes_with_stock', { p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudo obtener las recetas con existencia');
  return (data || []).map((r) => ({
    product_id: r.product_id,
    insumo_id: r.insumo_id,
    quantity_needed: r.quantity_needed,
    inventory: { id: r.insumo_id, name: r.insumo_name, unit: r.insumo_unit, stock: r.insumo_stock, min_stock: r.insumo_min_stock }
  }));
}

// IDs de productos que ya tienen receta configurada (para marcar "Sin receta" en catálogo).
async function getProductIdsWithRecipe() {
  const { data, error } = await supabase.rpc('get_product_ids_with_recipe', { p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudo obtener la lista de recetas');
  return (data || []).map((r) => r.product_id);
}

// Costo real (según receta) de todos los productos en una sola consulta,
// para mostrarlo en el catálogo sin hacer una llamada por producto.
async function getAllRecipeCosts() {
  const { data, error } = await supabase.rpc('get_all_recipe_costs', { p_branch_id: getCurrentBranchId() });
  must(error, 'No se pudo calcular el costo de las recetas');
  const costsByProduct = {};
  (data || []).forEach((r) => {
    costsByProduct[r.product_id] = Number(r.cost) || 0;
  });
  return costsByProduct;
}

// ==========================================================================
// 7. MERMA
// ==========================================================================
async function getAllWaste(filters = {}) {
  let query = supabase.from('waste').select('*').eq('branch_id', getCurrentBranchId());
  if (filters.dateFrom) query = query.gte('created_at', `${filters.dateFrom}T00:00:00`);
  if (filters.dateTo) query = query.lte('created_at', `${filters.dateTo}T23:59:59.999`);
  if (filters.tipo) query = query.eq('tipo', filters.tipo);
  query = query.order('id', { ascending: false });
  const { data, error } = await query;
  must(error, 'No se pudo obtener la merma');
  return data;
}

async function createWaste(data) {
  const tipo = data.tipo === 'consumo_interno' ? 'consumo_interno' : 'merma';
  const autorizadoPor = tipo === 'consumo_interno' ? String(data.autorizado_por || '').trim() : null;
  if (tipo === 'consumo_interno' && !autorizadoPor) {
    throw new Error('Indica qué jefe autoriza el consumo interno.');
  }

  const { data: row, error } = await supabase.rpc('create_waste_entry', {
    p_branch_id: getCurrentBranchId(),
    p_inventory_id: data.inventory_id || null,
    p_item_name: data.item_name,
    p_quantity: Number(data.quantity) || 0,
    p_unit: data.unit || 'pza',
    p_reason: data.reason,
    p_cost: data.cost ? Number(data.cost) : null,
    p_tipo: tipo,
    p_autorizado_por: autorizadoPor
  });
  must(error, 'No se pudo registrar la merma');
  return row;
}

// ==========================================================================
// 8. COSTOS
// ==========================================================================
async function getAllCosts(filters = {}) {
  let query = supabase.from('costs').select('*').eq('branch_id', getCurrentBranchId());
  if (filters.dateFrom) query = query.gte('date', filters.dateFrom);
  if (filters.dateTo) query = query.lte('date', filters.dateTo);
  query = query.order('date', { ascending: false }).order('id', { ascending: false });
  const { data, error } = await query;
  must(error, 'No se pudieron obtener los gastos');
  return data;
}

async function createCost(data) {
  const fallbackDate = data.date || new Date().toISOString().slice(0, 10);
  const { data: row, error } = await supabase.rpc('create_cost', {
    p_branch_id: getCurrentBranchId(),
    p_concept: data.concept,
    p_category: data.category || 'variable',
    p_amount: Number(data.amount) || 0,
    p_date: fallbackDate
  });
  must(error, 'No se pudo registrar el gasto');
  return row;
}

async function removeCost(id) {
  const { error } = await supabase.rpc('remove_cost', { p_branch_id: getCurrentBranchId(), p_id: id });
  must(error, 'No se pudo eliminar el gasto');
  return { deleted: true };
}

// ==========================================================================
// 8B. CORTE DE CAJA
// ==========================================================================
// Traduce la categoría de la salida (vocabulario del corte: repartidores/
// basura/insumos/otros) a la categoría que ya entiende el módulo de Costos
// (fijo/variable/insumo/servicio), para que el gasto espejado en "costs"
// siga contando correctamente en Reportes/Rentabilidad sin duplicar UI.
function mapCashCategoryToCostCategory(categoriaCosto) {
  const MAP = {
    repartidores: 'variable',
    basura: 'variable',
    insumos: 'insumo',
    otros: 'variable'
  };
  return MAP[categoriaCosto] || 'variable';
}
async function getCorteResumen(fecha) {
  // fecha = '2026-08-16', día local de la sucursal. Antes esto hardcodeaba
  // "Xalapa = UTC-6" a mano (${fecha}T06:00:00.000Z) más una vuelta de
  // getDate()/setDate() para el día siguiente -- dos errores de zona horaria
  // que casualmente se cancelaban entre sí mientras México no tuviera
  // horario de verano, pero quedaba frágil y desacoplado de la zona real del
  // equipo. Se unifica con el mismo helper que ya usa getUnifiedHistory
  // (localDayStartUtcIso/localDayEndUtcIso): toma la hora local real del
  // sistema operativo en vez de asumir un offset fijo.
  const inicioUTC = localDayStartUtcIso(fecha);
  const finUTC = localDayEndUtcIso(fecha);

  // payment_status IN ('pagado_en_caja', 'liquidado') es lo único que
  // realmente está en el cajón. 'dinero_con_repartidor' se excluye a
  // propósito: es un domicilio ya 'completada' (el cliente ya pagó) pero el
  // repartidor todavía no regresa el efectivo al local -- sumarlo aquí
  // infla "esperado en cajón" con dinero que físicamente no está.
  // 'pendiente' no debería aparecer nunca en una venta 'completada' (ver
  // comandaSetDeliveryStatus), pero se excluye igual por seguridad.
  const { data: sales, error: salesErr } = await supabase
   .from('sales')
   .select('total, delivery_fee, payment_method, status, created_at, client_type, employee_benefit_before, employee_benefit_after, payment_status')
   .eq('status', 'completada')
   .in('payment_status', ['pagado_en_caja', 'liquidado'])
   .eq('branch_id', getCurrentBranchId())
   .gte('created_at', inicioUTC)
   .lte('created_at', finUTC);
  must(salesErr, 'No se pudieron obtener las ventas del corte');

  // Dinero en calle: snapshot en vivo (no se filtra por fecha) de lo que los
  // repartidores traen consigo ahora mismo, sin liquidar. Un domicilio
  // entregado el día del corte pero liquidado después seguiría faltando del
  // "esperado en cajón" de ese día si esto se filtrara por fecha -- por eso
  // se muestra aparte, como aviso, y no se suma a ventasPorPago.
  const dineroEnCalle = await getPendingDriverMoney();
  const dineroEnCalleTotal = dineroEnCalle.reduce((sum, d) => sum + d.aRegresar, 0);

  let ventaComida = 0;
  let ventaEnvios = 0;
  let pedidosConEnvio = 0;
  let beneficioEmpleados = 0;
  let creditoNominaHoy = 0;
  const ventasPorPago = { efectivo: 0, tarjeta: 0, transferencia: 0 };

  // El beneficio de empleado ($100/día) y el excedente a crédito de nómina
  // nunca entraron a caja: se restan del total de la venta antes de sumarlo
  // a ventasPorPago, para que "esperado en cajón" no se infle con dinero que
  // nunca se cobró. ventaComida/ventaEnvios sí conservan el bruto (valor de
  // lo servido) para que Reportes siga reflejando el volumen real de venta.
  (sales || []).forEach((s) => {
    const total = Number(s.total) || 0;
    const fee = Number(s.delivery_fee) || 0;
    ventaComida += total - fee;
    if (fee > 0) {
      ventaEnvios += fee;
      pedidosConEnvio += 1;
    }

    const benefitUsed = s.client_type === 'employee'
      ? Math.max((Number(s.employee_benefit_before) || 0) - (Number(s.employee_benefit_after) || 0), 0)
      : 0;
    beneficioEmpleados += benefitUsed;

    const cashCountable = Math.max(total - benefitUsed, 0);
    const pm = s.payment_method || 'efectivo';

    if (pm === 'credito_nomina') {
      creditoNominaHoy += cashCountable;
    } else {
      ventasPorPago[pm] = (ventasPorPago[pm] || 0) + cashCountable;
    }
  });

  const { data: movimientos, error: movErr } = await supabase
   .from('cash_movements')
   .select('*')
   .eq('fecha', fecha)
   .eq('branch_id', getCurrentBranchId())
   .order('created_at', { ascending: false });
  must(movErr, 'No se pudieron obtener las salidas de caja');

  const salidasPorPago = { efectivo: 0, tarjeta: 0, transferencia: 0 };
  (movimientos || []).forEach((m) => {
    const mp = m.metodo_pago || 'efectivo';
    salidasPorPago[mp] = (salidasPorPago[mp] || 0) + (Number(m.monto) || 0);
  });

  const { data: cut, error: cutErr } = await supabase
   .from('cash_cuts')
   .select('*')
   .eq('fecha', fecha)
   .eq('branch_id', getCurrentBranchId())
   .maybeSingle();
  must(cutErr, 'No se pudo obtener el fondo inicial del corte');

  return {
    fecha,
    fondoInicial: cut? Number(cut.fondo_inicial || 0) : 0,
    efectivoReal: cut && cut.efectivo_real!= null? Number(cut.efectivo_real) : null,
    cerrado:!!(cut && cut.cerrado_at),
    cerradoPor: cut? cut.cerrado_por : null,
    cerradoAt: cut? cut.cerrado_at : null,
    ventaComida,
    ventaEnvios,
    pedidosConEnvio,
    ventaTotal: ventaComida + ventaEnvios,
    ventasPorPago,
    salidasPorPago,
    beneficioEmpleados,
    creditoNominaHoy,
    movimientos: movimientos || [],
    dineroEnCalle,
    dineroEnCalleTotal
  };
}
// Crea/actualiza el fondo inicial del día (upsert por fecha+sucursal: el
// admin puede corregirlo antes de cerrar sin generar renglones duplicados).
async function setCashCutFondoInicial(fecha, fondoInicial) {
  const { data, error } = await supabase.rpc('set_cash_cut_fondo_inicial', {
    p_branch_id: getCurrentBranchId(),
    p_fecha: fecha,
    p_fondo_inicial: Number(fondoInicial) || 0
  });
  must(error, 'No se pudo guardar el fondo inicial');
  return data;
}

// Registra una salida de caja manual (repartidores, basura, insumos, etc.).
// Nunca se genera automáticamente al marcar "En camino" (comanda_set_delivery
// solo cambia delivery_status): el cajero/admin la captura a mano desde este
// módulo. Se espeja en "costs" para que Reportes/Rentabilidad la contemple
// sin tener que sumar cash_movements en dos lugares distintos.
async function createCashMovement(data) {
  const fecha = data.fecha || new Date().toISOString().slice(0, 10);
  const concepto = String(data.concepto || '').trim();
  if (!concepto) throw new Error('El concepto de la salida es obligatorio.');

  // create_cash_movement (RPC) hace el mismo espejo en costs del lado del
  // servidor -- ver 20260820040000_rpc_branch_id_cash_and_costs.sql -- sin
  // revertir cash_movements si ese espejo falla, igual que aquí antes.
  const { data: row, error } = await supabase.rpc('create_cash_movement', {
    p_branch_id: getCurrentBranchId(),
    p_fecha: fecha,
    p_concepto: concepto,
    p_monto: Number(data.monto) || 0,
    p_metodo_pago: data.metodo_pago || 'efectivo',
    p_categoria_costo: data.categoria_costo || 'otros'
  });
  must(error, 'No se pudo registrar la salida de caja');
  return row;
}

async function removeCashMovement(id) {
  const { error } = await supabase.rpc('remove_cash_movement', { p_branch_id: getCurrentBranchId(), p_id: id });
  must(error, 'No se pudo eliminar la salida de caja');
  return { deleted: true };
}

// Cierra el corte del día: guarda el efectivo contado físicamente y calcula
// la diferencia contra lo esperado en el cajón (fondo inicial + efectivo
// neto), tal como se le mostró al usuario en el ticket antes de confirmar.
async function closeCashCut(fecha, efectivoReal, closedBy) {
  const resumen = await getCorteResumen(fecha);
  const efectivoNeto = (resumen.ventasPorPago.efectivo || 0) - (resumen.salidasPorPago.efectivo || 0);
  const esperado = resumen.fondoInicial + efectivoNeto;
  const real = Number(efectivoReal) || 0;
  const cerradoPor = closedBy || 'admin';

  // close_cash_cut (RPC) hace el mismo "actualiza si ya existe, si no
  // inserta" -- ver 20260820040000_rpc_branch_id_cash_and_costs.sql -- el
  // cálculo de esperado/diferencia sigue en JS porque ya viene de
  // getCorteResumen (lectura).
  const { data, error } = await supabase.rpc('close_cash_cut', {
    p_branch_id: getCurrentBranchId(),
    p_fecha: fecha,
    p_fondo_inicial: resumen.fondoInicial,
    p_efectivo_real: real,
    p_cerrado_por: cerradoPor
  });

  if (error) {
    console.error('[closeCashCut] Error real de Supabase:', error);
    throw new Error(`No se pudo cerrar el corte de caja: ${error.message}`);
  }

  return { ...data, esperado, diferencia: real - esperado };
}

// Historial de cortes cerrados/abiertos en un rango de fechas, para la
// pantalla de Reportes (selección por fila -> detalle del día).
async function getCashCutsHistory(dateFrom, dateTo) {
  const { data, error } = await supabase
    .from('cash_cuts')
    .select('*')
    .eq('branch_id', getCurrentBranchId())
    .gte('fecha', dateFrom)
    .lte('fecha', dateTo)
    .order('fecha', { ascending: false });
  must(error, 'No se pudo obtener el historial de cortes');
  return data || [];
}

async function getCorteByFecha(fecha) {
  const { data, error } = await supabase
    .from('cash_cuts')
    .select('*')
    .eq('fecha', fecha)
    .eq('branch_id', getCurrentBranchId())
    .maybeSingle();
  must(error, 'No se pudo obtener el corte de esa fecha');
  return data;
}

// ==========================================================================
// 9. REPORTES / RENTABILIDAD
// ==========================================================================
async function computeProfitability(dateFrom, dateTo) {
  // Mismo bug de zona horaria ya corregido en getUnifiedHistory/getCorteResumen
  // (string sin offset, Postgres lo interpreta en UTC del servidor, no en la
  // hora local) -- esta función quedó pendiente en esa sesión, se cierra aquí.
  const fromTs = localDayStartUtcIso(dateFrom);
  const toTs = localDayEndUtcIso(dateTo);

  const { data: sales, error: salesErr } = await supabase
    .from('sales').select('total, payment_method, created_at')
    .eq('status', 'completada').eq('branch_id', getCurrentBranchId()).gte('created_at', fromTs).lte('created_at', toTs);
  must(salesErr, 'No se pudo calcular el reporte');

  const { data: wasteRows, error: wasteErr } = await supabase
    .from('waste').select('cost').eq('branch_id', getCurrentBranchId()).gte('created_at', fromTs).lte('created_at', toTs);
  must(wasteErr);

  const { data: costRows, error: costErr } = await supabase
    .from('costs').select('amount').eq('branch_id', getCurrentBranchId()).gte('date', dateFrom).lte('date', dateTo);
  must(costErr);

  const { data: items, error: itemsErr } = await supabase.rpc('get_sale_items_summary', {
    p_branch_id: getCurrentBranchId(),
    p_from: fromTs,
    p_to: toTs
  });
  must(itemsErr);

  // Food cost / margen / valuación (feature nueva 2026-08-21): reusa lo que
  // ya existe (getAllProducts, getAllRecipeCosts, getAllInventory), todo ya
  // filtrado por sucursal -- no hace falta ninguna consulta extra a mano.
  const [allProducts, recipeCostByProduct, allInventory] = await Promise.all([
    getAllProducts(),
    getAllRecipeCosts(),
    getAllInventory()
  ]);
  const productsById = new Map((allProducts || []).map((p) => [p.id, p]));

  // Costo de un producto: si tiene receta (stock NULL), el costo de receta
  // ya calculado; si es "directo" (stock NOT NULL), su cost_per_unit propio
  // -- null si nunca se capturó (margen desconocido, no se inventa un 0).
  const foodCostOf = (product) => {
    if (!product) return null;
    if (product.stock == null) {
      const recipeCost = recipeCostByProduct[product.id];
      return recipeCost != null ? recipeCost : null;
    }
    return product.cost_per_unit != null ? Number(product.cost_per_unit) : null;
  };

  const totalSales = (sales || []).reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalTickets = (sales || []).length;
  const totalWaste = (wasteRows || []).reduce((sum, w) => sum + Number(w.cost || 0), 0);
  const totalCosts = (costRows || []).reduce((sum, c) => sum + Number(c.amount || 0), 0);

  const byProduct = {};
  let cogs = 0;
  let cogsUnknownCount = 0;
  (items || []).forEach((it) => {
    if (!byProduct[it.name]) byProduct[it.name] = { name: it.name, unidades: 0, total: 0 };
    byProduct[it.name].unidades += Number(it.quantity || 0);
    byProduct[it.name].total += Number(it.subtotal || 0);

    // COGS solo cubre item_type='product' (con receta o costo directo
    // capturado): un combo/promo (item_type='promo') se arma de varios
    // productos vía product_components, que no se recorre aquí -- se deja
    // fuera del costo de venta por ahora en vez de adivinar su costo.
    if (it.item_type === 'product' && it.ref_id != null) {
      const cost = foodCostOf(productsById.get(it.ref_id));
      if (cost != null) {
        cogs += cost * (Number(it.quantity) || 0);
      } else {
        cogsUnknownCount += 1;
      }
    }
  });
  const topProducts = Object.values(byProduct).sort((a, b) => b.total - a.total).slice(0, 8);

  const productMargins = (allProducts || [])
    .filter((p) => Number(p.price) > 0)
    .map((p) => {
      const foodCost = foodCostOf(p);
      const margin = foodCost != null ? Number(p.price) - foodCost : null;
      return {
        id: p.id,
        name: p.name,
        price: Number(p.price),
        isRecipe: p.stock == null,
        foodCost,
        margin,
        marginPct: margin != null && Number(p.price) > 0 ? margin / Number(p.price) : null
      };
    })
    .sort((a, b) => (a.marginPct ?? Infinity) - (b.marginPct ?? Infinity));

  const inventoryValuation = (allInventory || []).reduce(
    (sum, i) => sum + (Number(i.stock) || 0) * (Number(i.cost_per_unit) || 0),
    0
  );

  const byDayMap = {};
  (sales || []).forEach((s) => {
    const day = (s.created_at || '').slice(0, 10);
    byDayMap[day] = (byDayMap[day] || 0) + Number(s.total || 0);
  });
  const byDay = Object.keys(byDayMap).sort().map((day) => ({ day, total: byDayMap[day] }));

  const byPaymentMap = {};
  (sales || []).forEach((s) => {
    const pm = s.payment_method || 'efectivo';
    if (!byPaymentMap[pm]) byPaymentMap[pm] = { payment_method: pm, total: 0, tickets: 0 };
    byPaymentMap[pm].total += Number(s.total || 0);
    byPaymentMap[pm].tickets += 1;
  });

  return {
    dateFrom,
    dateTo,
    totalSales,
    totalTickets,
    totalWaste,
    totalCosts,
    netProfit: totalSales - totalWaste - totalCosts,
    topProducts,
    byDay,
    byPayment: Object.values(byPaymentMap),
    // Food cost / margen / valuación: cogs y grossProfit solo cubren
    // item_type='product' (ver cogsUnknownCount) -- combos/promos y
    // productos directos sin cost_per_unit capturado quedan fuera del
    // costo de venta, no se les inventa un valor.
    cogs,
    cogsUnknownCount,
    grossProfit: totalSales - cogs,
    productMargins,
    inventoryValuation
  };
}

// ==========================================================================
// 10. EMPLEADOS Y ASISTENCIA
// ==========================================================================
async function getAllEmployees() {
    const { data, error } = await supabase
        .from('employees')
        .select('*')
        .eq('branch_id', getCurrentBranchId())
        .order('active', { ascending: false })
        .order('name', { ascending: true });

    if (error) {
        console.error('Supabase employees:getAll:', error);
        throw new Error(
            error.message || 'No se pudieron obtener los empleados'
        );
    }

    console.log('Empleados cargados desde Supabase:', data);

    return data || [];
}
async function createEmployee(data) {
    const name = String(data?.name || '').trim();

    if (!name) {
        throw new Error('El nombre del empleado es obligatorio.');
    }

    const role =
        String(data?.role || 'Personal').trim() || 'Personal';

    const salary = Number.isFinite(Number(data?.salary))
        ? Number(data.salary)
        : 0;

    const weeklyBonus = Number.isFinite(Number(data?.weekly_bonus))
        ? Number(data.weekly_bonus)
        : 0;

    const active = data?.active !== false;

    console.log('Creando empleado mediante RPC:', {
        name,
        role,
        salary,
        weeklyBonus,
        active
    });

    // PENDIENTE: create_employee todavía no recibe p_branch_id -- RPC "caja
    // negra", ver 20260820060000_tmp_introspect_pending_rpcs.sql. Agregar
    // `p_branch_id: getCurrentBranchId()` aquí en cuanto exista 0009-parte-2
    // (y employees.branch_id ya no dependa del DEFAULT -- ver
    // 20260820900000_drop_branch_default_RUN_LAST.sql).
    const { data: row, error } = await supabase.rpc(
        'create_employee',
        {
            p_name: name,
            p_role: role,
            p_salary: salary,
            p_weekly_bonus: weeklyBonus,
            p_active: active
        }
    );

    if (error) {
        console.error('Supabase create_employee:', error);
        throw new Error(
            error.message || 'No se pudo crear el empleado'
        );
    }

    if (!row) {
        throw new Error('Supabase no devolvió el empleado creado.');
    }

    console.log('Empleado creado correctamente:', row);

    return row;
}

async function updateEmployee(id, data) {
  const { data: row, error } = await supabase.rpc('update_employee', {
    p_branch_id: getCurrentBranchId(),
    p_id: id,
    p_name: data.name,
    p_role: data.role || 'Personal',
    p_salary: Number(data.salary) || 0,
    p_weekly_bonus: Number(data.weekly_bonus) || 0,
    p_active: data.active !== false
  });
  must(error, 'No se pudo actualizar el empleado');
  return row;
}

async function removeEmployee(id) {
  const { data, error } = await supabase.rpc('remove_employee', { p_branch_id: getCurrentBranchId(), p_id: id });
  must(error, 'No se pudo eliminar el empleado');
  return data;
}

// NO redeclarar localDateStr aquí -- ya existe arriba (línea ~65, hora
// local, usada por getWeekRange/isoMondayOf). Hasta 2026-08-22 hubo una
// SEGUNDA función con el mismo nombre justo aquí, implementada con
// `d.toISOString().slice(0,10)` (UTC, no local) -- al ser dos declaraciones
// `function` con el mismo nombre en el mismo scope de módulo, la segunda
// pisaba silenciosamente a la primera para TODO el archivo, incluidas las
// llamadas de getPayrollData/getPayrollDetail (líneas ~2322/2444) que
// convierten cada timestamp de asistencia a "qué día fue" para calcular
// faltas: cualquier checada después de ~6pm hora local (turno de cierre)
// se archivaba bajo el día SIGUIENTE en UTC, marcando al empleado como
// "falta" el día que sí trabajó y "presente" un día que no. Bug real de
// nómina, no solo de Asistencia -- corregido eliminando el duplicado.
async function getTodayAttendance() {
  const today = localDateStr(new Date());
  const { data, error } = await supabase
    .from('attendance').select('*')
    .eq('branch_id', getCurrentBranchId())
    .gte('timestamp', localDayStartUtcIso(today)).lte('timestamp', localDayEndUtcIso(today))
    .order('timestamp', { ascending: false });
  must(error, 'No se pudo obtener la asistencia de hoy');
  return data;
}

async function getAllAttendance(filters = {}) {
  let query = supabase.from('attendance').select('*').eq('branch_id', getCurrentBranchId());
  if (filters.dateFrom) query = query.gte('timestamp', localDayStartUtcIso(filters.dateFrom));
  if (filters.dateTo) query = query.lte('timestamp', localDayEndUtcIso(filters.dateTo));
  query = query.order('timestamp', { ascending: false });
  const { data, error } = await query;
  must(error, 'No se pudo obtener la asistencia');
  return data;
}

// register_attendance sigue siendo un RPC "caja negra" (no versionado en
// este repo, ver 20260820060000_tmp_introspect_pending_rpcs.sql) que NO
// recibe p_branch_id -- no se reescribe a ciegas (regla del proyecto: no
// tocar RPC sin ver su definición real primero). Mientras tanto, esta
// validación de sucursal se hace aquí del lado del cliente: sin esto,
// nada impedía registrar asistencia para un employeeId de otra sucursal
// si algo (bug futuro, llamada directa) mandara uno que no viniera ya del
// selector de empleados (que sí está filtrado por sucursal).
async function registerAttendance(employeeId) {
  const { data: emp, error: empErr } = await supabase
    .from('employees').select('id').eq('id', employeeId).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(empErr, 'No se pudo verificar el empleado');
  if (!emp) throw new Error('El empleado no existe o no pertenece a esta sucursal.');

  const { data, error } = await supabase.rpc('register_attendance', { p_employee_id: employeeId });
  must(error, 'No se pudo registrar la asistencia');
  return data;
}

// ==========================================================================
// 11. NÓMINA
// ==========================================================================
async function getPayrollWeek(weekStart) {
  const { data: employees, error } = await supabase.from('employees').select('*').eq('branch_id', getCurrentBranchId()).eq('active', true).order('name');
  must(error, 'No se pudieron obtener los empleados');
  const { data: records, error: recErr } = await supabase.from('payroll_weeks').select('*').eq('week_start', weekStart);
  must(recErr, 'No se pudo obtener la nómina de la semana');

  const { data: creditRows, error: credErr } = await supabase.rpc(
    'get_payroll_week_credit',
    { p_week_start: weekStart }
  );
  must(credErr, 'No se pudo obtener el crédito semanal de empleados');

  const byEmployee = {};
  (records || []).forEach((r) => (byEmployee[r.employee_id] = r));

  const creditByEmployee = {};
  (creditRows || []).forEach((r) => (creditByEmployee[r.employee_id] = r));

  return (employees || []).map((emp) => {
    const record = byEmployee[emp.id];
    const credit = creditByEmployee[emp.id];
    return {
      employeeId: emp.id,
      employeeName: emp.name,
      role: emp.role,
      salary: emp.salary,
      weeklyBonus: emp.weekly_bonus,
      bonusCredited: record ? !!record.bonus_credited : false,
      grossTotal: record
        ? Number(record.total || 0)
        : Number(emp.salary || 0),
      saved: !!record,
      weeklyCreditAmount: credit ? Number(credit.credit_amount || 0) : 0,
      weeklyCashExtra: credit ? Number(credit.paid_amount || 0) : 0,
      total: Math.max(
        (record ? Number(record.total || 0) : Number(emp.salary || 0))
        - (credit ? Number(credit.credit_amount || 0) : 0)
        - (credit ? Number(credit.paid_amount || 0) : 0),
        0
      )
    };
  });
}

// Deducciones de nómina pendientes de la semana: beneficio de empleado que
// se fue a crédito (excedente sobre los $100/día, o "para llevar - crédito")
// y aún no se ha descontado del pago. Reusa getPayrollWeek en vez de leer
// employee_weekly_credit directamente (esa tabla tiene RLS y solo es legible
// vía el RPC get_payroll_week_credit que ya envuelve getPayrollWeek).
async function getPayrollDeductionsPendientes(weekStart) {
  const week = await getPayrollWeek(weekStart);
  return week
    .filter((w) => w.weeklyCreditAmount + w.weeklyCashExtra > 0)
    .map((w) => ({
      employeeId: w.employeeId,
      employeeName: w.employeeName,
      weekStart,
      creditoSemanal: w.weeklyCreditAmount,
      efectivoExcedente: w.weeklyCashExtra,
      totalDeducir: w.weeklyCreditAmount + w.weeklyCashExtra
    }));
}

async function setPayrollBonus(payload) {
  const { data, error } = await supabase.rpc('set_payroll_bonus', {
    p_employee_id: payload.employeeId,
    p_week_start: payload.weekStart,
    p_bonus_credited: !!payload.bonusCredited
  });
  must(error, 'No se pudo guardar el bono de la semana');
  return data;
}

async function getPayrollHistory(filters = {}) {
  let query = supabase.from('payroll_weeks').select('*');
  if (filters.weekFrom) query = query.gte('week_start', filters.weekFrom);
  if (filters.weekTo) query = query.lte('week_start', filters.weekTo);
  query = query.order('week_start', { ascending: false }).order('employee_name', { ascending: true });
  const { data, error } = await query;
  must(error, 'No se pudo obtener el historial de nómina');
  return data;
}

// ==========================================================================
// 11B. NÓMINA CONFIGURABLE (día de pago, faltas, cierre semanal)
// ==========================================================================
async function getPayrollSettings() {
  const settings = await getAllSettings();
  let day = 'sabado';
  let dayNumber = 6;
  if (settings.payroll_payday) {
    try {
      const parsed = JSON.parse(settings.payroll_payday);
      if (parsed.day) day = parsed.day;
      if (Number.isInteger(parsed.day_number)) dayNumber = parsed.day_number;
    } catch {
      // valor legado/corrupto: se usa el default (sábado)
    }
  }
  return { day, dayNumber };
}

// Semana laboral = 6 días hábiles (todos menos el día siguiente al de pago,
// que es el descanso). Ej. payday=sábado -> semana domingo-sábado, descanso
// implícito ninguno adicional; el divisor de tarifa diaria es 6 porque el
// día de pago (o el día siguiente, según el negocio) no se exige asistencia.
// Aquí se asume que el único día sin asistencia esperada es el que sigue al
// de pago (domingo si payday=sábado).
function faltaDeductionDivisor() {
  return 6;
}

async function getEmployeesWithAttendanceHistory() {
  const { data, error } = await supabase.from('attendance').select('employee_id');
  must(error, 'No se pudo verificar el historial de asistencia');
  return new Set((data || []).map((a) => a.employee_id));
}

async function getPayrollData(weekStart, weekEnd) {
  const { data: employees, error: empErr } = await supabase
    .from('employees').select('*').eq('branch_id', getCurrentBranchId()).eq('active', true).order('name');
  must(empErr, 'No se pudieron obtener los empleados');

  // Bono acreditado y crédito semanal por excedente viven en payroll_weeks /
  // employee_weekly_credit, ambas indexadas por semana ISO lunes-domingo
  // (ver isoMondayOf); weekStart/weekEnd aquí son el rango que se muestra en
  // pantalla (respeta el día de pago configurado) y se usan tal cual para
  // faltas y beneficio $100, que sí son consultas por rango de timestamp.
  const bonusWeekStart = isoMondayOf(weekEnd);

  const { data: bonusRecords, error: bonusErr } = await supabase
    .from('payroll_weeks')
    .select('employee_id, bonus_credited')
    .eq('week_start', bonusWeekStart);
  must(bonusErr, 'No se pudo obtener el bono acreditado de la semana');

  const { data: creditRows, error: credErr } = await supabase.rpc(
    'get_payroll_week_credit',
    { p_week_start: bonusWeekStart }
  );
  must(credErr, 'No se pudo obtener el crédito semanal de empleados');

  const { data: attendance, error: attErr } = await supabase
    .from('attendance')
    .select('employee_id, timestamp')
    .eq('branch_id', getCurrentBranchId())
    .gte('timestamp', localDayStartUtcIso(weekStart))
    .lte('timestamp', localDayEndUtcIso(weekEnd));
  must(attErr, 'No se pudo obtener la asistencia de la semana');

  // Mientras un empleado no tenga NINGÚN registro histórico de asistencia,
  // no se le calculan faltas: sin ese dato, "sin checar" no distingue entre
  // "faltó" y "no se usa el checador para él", y descontarle el sueldo
  // completo por defecto sería un error grave. En cuanto tenga al menos un
  // registro alguna vez, el cálculo de faltas se activa solo para él.
  const employeesWithAttendanceHistory = await getEmployeesWithAttendanceHistory();

  // employee_consumption tiene RLS sin policy anon (ver comentario en
  // getEmployeeDailyConsumption): el beneficio usado se calcula desde
  // sales.employee_benefit_before/after, que sí es legible, igual que en
  // getCorteResumen.
  const { data: ventasEmpleado, error: consErr } = await supabase
    .from('sales')
    .select('employee_id, employee_benefit_before, employee_benefit_after')
    .eq('client_type', 'employee')
    .eq('status', 'completada')
    .eq('branch_id', getCurrentBranchId())
    .gte('created_at', localDayStartUtcIso(weekStart))
    .lte('created_at', localDayEndUtcIso(weekEnd));
  must(consErr, 'No se pudo obtener el beneficio de empleados de la semana');

  const bonusByEmployee = {};
  (bonusRecords || []).forEach((r) => (bonusByEmployee[r.employee_id] = !!r.bonus_credited));

  const creditByEmployee = {};
  (creditRows || []).forEach((r) => (creditByEmployee[r.employee_id] = r));

  const attByEmployee = {};
  (attendance || []).forEach((a) => {
    const key = a.employee_id;
    if (!attByEmployee[key]) attByEmployee[key] = new Set();
    attByEmployee[key].add(localDateStr(new Date(a.timestamp)));
  });

  const benefitByEmployee = {};
  (ventasEmpleado || []).forEach((s) => {
    const used = Math.max((Number(s.employee_benefit_before) || 0) - (Number(s.employee_benefit_after) || 0), 0);
    benefitByEmployee[s.employee_id] = (benefitByEmployee[s.employee_id] || 0) + used;
  });

  const today = localDateStr(new Date());
  const workDays = [];
  const cursor = new Date(`${weekStart}T00:00:00`);
  const endDate = new Date(`${weekEnd}T00:00:00`);
  while (cursor <= endDate) {
    const iso = localDateStr(cursor);
    // Domingo (0) se asume descanso: no cuenta como falta si no hay asistencia.
    if (cursor.getDay() !== 0 && iso <= today) workDays.push(iso);
    cursor.setDate(cursor.getDate() + 1);
  }

  return (employees || []).map((emp) => {
    const salary = Number(emp.salary) || 0;
    const bonoSemanal = Number(emp.weekly_bonus) || 0;
    const bonusCredited = !!bonusByEmployee[emp.id];
    const credit = creditByEmployee[emp.id];
    const creditoSemanal = Number(credit?.credit_amount) || 0;
    const efectivoExcedente = Number(credit?.paid_amount) || 0;
    const tieneHistorialAsistencia = employeesWithAttendanceHistory.has(emp.id);
    const diasAsistidos = attByEmployee[emp.id] || new Set();
    const faltas = tieneHistorialAsistencia ? workDays.filter((d) => !diasAsistidos.has(d)).length : 0;
    const deduccionFaltas = Math.round((salary / faltaDeductionDivisor()) * faltas * 100) / 100;
    const beneficioUsado = benefitByEmployee[emp.id] || 0;
    const totalAPagar = Math.max(
      salary + (bonusCredited ? bonoSemanal : 0) - creditoSemanal - efectivoExcedente - deduccionFaltas,
      0
    );

    return {
      employeeId: emp.id,
      employeeName: emp.name,
      puesto: emp.role,
      sueldoBase: salary,
      bonoSemanal,
      bonusCredited,
      bonusWeekStart,
      creditoSemanal,
      efectivoExcedente,
      faltas,
      deduccionFaltas,
      beneficioUsado,
      totalAPagar,
      sinHistorialAsistencia: !tieneHistorialAsistencia
    };
  });
}

// Acredita/desacredita el bono semanal desde el módulo Nómina unificado.
// Reusa setPayrollBonus (payroll_weeks + RPC set_payroll_bonus, ya probado)
// traduciendo la semana visible (weekEnd = día de pago) a su semana ISO
// lunes-domingo -- ver isoMondayOf.
async function saveBonoAcreditacion(employeeId, weekEnd, acredita) {
  return setPayrollBonus({
    employeeId,
    weekStart: isoMondayOf(weekEnd),
    bonusCredited: !!acredita
  });
}

async function getPayrollDetail(employeeName, weekStart, weekEnd) {
  const { data: creditos, error: credErr } = await supabase
    .from('payroll_deductions')
    .select('*')
    .eq('employee_name', employeeName)
    .eq('branch_id', getCurrentBranchId())
    .eq('status', 'pendiente')
    .gte('created_at', localDayStartUtcIso(weekStart))
    .lte('created_at', localDayEndUtcIso(weekEnd))
    .order('created_at', { ascending: false });
  must(credErr, 'No se pudieron obtener los créditos del empleado');

  const { data: employee, error: empErr } = await supabase
    .from('employees').select('id').eq('name', employeeName).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(empErr);

  let beneficio = [];
  if (employee) {
    const { data: ventas, error: ventasErr } = await supabase
      .from('sales')
      .select('created_at, employee_benefit_before, employee_benefit_after')
      .eq('employee_id', employee.id)
      .eq('client_type', 'employee')
      .eq('status', 'completada')
      .gte('created_at', localDayStartUtcIso(weekStart))
      .lte('created_at', localDayEndUtcIso(weekEnd))
      .order('created_at', { ascending: false });
    must(ventasErr, 'No se pudo obtener el beneficio de empleado del empleado');
    beneficio = (ventas || [])
      .map((s) => ({
        created_at: s.created_at,
        usado: Math.max((Number(s.employee_benefit_before) || 0) - (Number(s.employee_benefit_after) || 0), 0)
      }))
      .filter((s) => s.usado > 0);
  }

  let faltasDias = [];
  if (employee) {
    const { count: historyCount, error: histErr } = await supabase
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('employee_id', employee.id)
      .eq('branch_id', getCurrentBranchId());
    must(histErr);

    const { data: attendance, error: attErr } = await supabase
      .from('attendance')
      .select('timestamp')
      .eq('employee_id', employee.id)
      .eq('branch_id', getCurrentBranchId())
      .gte('timestamp', localDayStartUtcIso(weekStart))
      .lte('timestamp', localDayEndUtcIso(weekEnd));
    must(attErr);
    const diasAsistidos = historyCount > 0
      ? new Set((attendance || []).map((a) => localDateStr(new Date(a.timestamp))))
      : null;
    if (diasAsistidos) {
      const today = localDateStr(new Date());
      const cursor = new Date(`${weekStart}T00:00:00`);
      const endDate = new Date(`${weekEnd}T00:00:00`);
      while (cursor <= endDate) {
        const iso = localDateStr(cursor);
        if (cursor.getDay() !== 0 && iso <= today && !diasAsistidos.has(iso)) faltasDias.push(iso);
        cursor.setDate(cursor.getDate() + 1);
      }
    }
  }

  return { creditos: creditos || [], faltasDias, beneficio };
}

// Cierra la nómina de la semana: guarda un snapshot por empleado en
// payroll_history y marca las deducciones consideradas como 'descontado'
// para que no se vuelvan a contar en semanas futuras.
async function closePayrollWeek(weekStart, weekEnd, closedBy) {
  const rows = await getPayrollData(weekStart, weekEnd);

  const snapshot = rows.map((r) => ({
    week_start: weekStart,
    week_end: weekEnd,
    employee_id: r.employeeId,
    employee_name: r.employeeName,
    sueldo_base: r.sueldoBase,
    // payroll_history no tiene columnas separadas para bono/efectivo
    // excedente; 'creditos' guarda aquí el total de ambas deducciones
    // semanales (crédito de consumo + efectivo excedente), consistente con
    // total_pagado ya neto de todo.
    creditos: r.creditoSemanal + r.efectivoExcedente,
    faltas: r.faltas,
    deduccion_faltas: r.deduccionFaltas,
    beneficio_usado: r.beneficioUsado,
    total_pagado: r.totalAPagar,
    cerrado_por: closedBy || 'admin',
    branch_id: getCurrentBranchId()
  }));

  if (snapshot.length > 0) {
    const { error: histErr } = await supabase
      .from('payroll_history')
      .upsert(snapshot, { onConflict: 'week_start,employee_id' });
    must(histErr, 'No se pudo guardar el historial de nómina');
  }

  // Sin el filtro de branch_id esto marcaba como 'descontado' las
  // deducciones pendientes de CUALQUIER sucursal en el rango de fechas --
  // cerrar la nómina de una sucursal habría liquidado también las
  // deducciones de otra que ni siquiera hubiera cerrado todavía.
  const { error: updErr } = await supabase
    .from('payroll_deductions')
    .update({ status: 'descontado' })
    .eq('status', 'pendiente')
    .eq('branch_id', getCurrentBranchId())
    .gte('created_at', localDayStartUtcIso(weekStart))
    .lte('created_at', localDayEndUtcIso(weekEnd));
  must(updErr, 'No se pudo cerrar la nómina');

  return { closed: true, employees: snapshot.length };
}

// ==========================================================================
// 11C. HISTORIAL UNIFICADO
// ==========================================================================
// tipo de cada fila del historial:
//   'venta'              -> mostrador/mesa (client_type != 'Llevar')
//   'para_llevar'        -> client_type = 'Llevar', is_delivery = false
//   'domicilio'          -> client_type = 'Llevar', is_delivery = true
//   'beneficio_empleado' -> fila derivada (no una tabla propia) por cada
//                           venta de empleado con benefit_used > 0; el monto
//                           es solo la parte comida, no el total de la venta
//   'consumo_interno'    -> waste.tipo = 'consumo_interno' ("Consumo Jefes")
//   'merma'              -> waste.tipo = 'merma'
const HISTORY_PAYMENT_LABELS = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito_nomina: 'Crédito Nómina',
  beneficio_empleado: 'Beneficio (no cobrado)'
};

// El escritorio abre pedidos para llevar con client_type 'Para llevar'
// (comanda_open_takeout) y la web con 'Llevar' (process_sale); ambos deben
// clasificarse igual aquí (ver mismo patrón en getOpenTakeoutOrders).
const TAKEOUT_CLIENT_TYPES = ['para llevar', 'llevar'];
function saleHistoryTipo(sale) {
  if (TAKEOUT_CLIENT_TYPES.includes(String(sale.client_type || '').toLowerCase())) {
    return sale.is_delivery ? 'domicilio' : 'para_llevar';
  }
  return 'venta';
}

// Ventas legadas usan 'completada' (español, valor real que inserta
// process_sale/las RPC de comandas -- ver 20260820020000_rpc_branch_id_core_sales.sql);
// se acepta también 'completed'/'completado' por si hay datos de otro origen,
// pero 'completada' es el único valor que este código realmente escribe hoy.
const SALE_HISTORY_STATUSES = ['completada', 'completed', 'completado'];
const WASTE_HISTORY_TIPOS = ['merma', 'consumo_interno'];

function normalizeHistoryDate(str) {
  if (!str) return null;
  const dmy = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(str);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    return `${yyyy}-${mm}-${dd}`;
  }
  return String(str).slice(0, 10);
}

// PostgREST/Postgres interpretan un timestamp sin offset ('YYYY-MM-DDTHH:mm:ss')
// en la zona del SERVIDOR (UTC en Supabase), no en la del escritorio. Mandar la
// hora local tal cual desfasa la ventana de "Hoy" por el huso horario local y
// puede dejar fuera ventas del día -- por eso se construye un Date local y se
// convierte a su instante UTC real con toISOString() antes de filtrar.
function localDayStartUtcIso(dateStr) {
  return new Date(`${dateStr}T00:00:00`).toISOString();
}
function localDayEndUtcIso(dateStr) {
  return new Date(`${dateStr}T23:59:59.999`).toISOString();
}

async function getUnifiedHistory(filters = {}) {
  const startDate = normalizeHistoryDate(filters.startDate) || '2000-01-01';
  const endDate = normalizeHistoryDate(filters.endDate) || '2999-12-31';
  const fromTs = localDayStartUtcIso(startDate);
  const toTs = localDayEndUtcIso(endDate);
  const branchId = getCurrentBranchId();

  const { data: sales, error: salesErr } = await supabase
    .from('sales')
    .select('*')
    .in('status', SALE_HISTORY_STATUSES)
    .eq('branch_id', branchId)
    .gte('created_at', fromTs)
    .lte('created_at', toTs)
    .order('created_at', { ascending: false });
  must(salesErr, 'No se pudo obtener el historial de ventas');

  const saleIds = (sales || []).map((s) => s.id);
  let itemsBySale = {};
  if (saleIds.length > 0) {
    const items = await getSaleItemsWithModifiers(saleIds);
    const modifierNameMap = await getModifierNameMap();
    (items || []).forEach((it) => {
      if (!itemsBySale[it.sale_id]) itemsBySale[it.sale_id] = [];
      const modifiers = (it.sale_item_modifiers || [])
        .map((sim) => modifierNameMap.get(sim.modifier_id))
        .filter(Boolean);
      itemsBySale[it.sale_id].push({ ...it, modifiers });
    });
  }

  // Si el usuario ya filtra por un tipo específico, no traigas de más: si es
  // un tipo de merma/waste, acota la query a ese; si es un tipo de venta
  // (venta/para_llevar/domicilio/beneficio_empleado/credito_nomina) ninguna
  // fila de waste puede calzar, así que ni se consulta.
  let wasteTipoFilter = WASTE_HISTORY_TIPOS;
  if (filters.tipo && filters.tipo !== 'todos') {
    wasteTipoFilter = WASTE_HISTORY_TIPOS.includes(filters.tipo) ? [filters.tipo] : null;
  }

  let waste = [];
  if (wasteTipoFilter) {
    try {
      // waste.branch_id ya existe (columna agregada 2026-08-21), pero hay
      // filas viejas con branch_id NULL -- para esas se cae a inventory_id
      // para inferir la sucursal. Si no toca ninguna fila no truena el
      // historial completo, solo se registra y se sigue con waste vacío.
      const { data: inv, error: invErr } = await supabase
        .from('inventory')
        .select('id')
        .eq('branch_id', branchId);
      if (invErr) throw invErr;
      const invIds = (inv || []).map((i) => i.id);

      let query = supabase
        .from('waste')
        .select('*')
        .in('tipo', wasteTipoFilter)
        .gte('created_at', fromTs)
        .lte('created_at', toTs)
        .order('created_at', { ascending: false });

      query = invIds.length > 0
        ? query.or(`branch_id.eq.${branchId},and(branch_id.is.null,inventory_id.in.(${invIds.join(',')}))`)
        : query.eq('branch_id', branchId);

      const { data: wasteData, error: wasteErr } = await query;
      if (wasteErr) throw wasteErr;
      waste = wasteData || [];
    } catch (e) {
      console.warn('No se pudo obtener merma/consumo interno para el historial:', e.message || e);
      waste = [];
    }
  }

  const rows = [];

  (sales || []).forEach((s) => {
    const items = itemsBySale[s.id] || [];
    const detalle = items.length
      ? items.map((it) => `${it.quantity}x ${it.name}`).join(', ')
      : s.folio;

    rows.push({
      id: `venta-${s.id}`,
      saleId: s.id,
      fecha: s.created_at,
      tipo: saleHistoryTipo(s),
      detalle,
      total: Number(s.total) || 0,
      metodo: s.payment_method,
      metodoLabel: HISTORY_PAYMENT_LABELS[s.payment_method] || s.payment_method,
      autorizoCliente: s.is_delivery ? (s.customer_name || 'Sin nombre') : (s.employee_name || s.client_type),
      empleadoNombre: s.employee_name || null,
      folio: s.folio,
      items,
      repartidor: s.is_delivery ? s.driver_name : null,
      direccion: s.is_delivery ? s.delivery_address : null,
      telefono: s.is_delivery ? s.customer_phone : null,
      paymentStatus: s.payment_status || null
    });

    const benefitUsed = s.client_type === 'employee'
      ? Math.max((Number(s.employee_benefit_before) || 0) - (Number(s.employee_benefit_after) || 0), 0)
      : 0;
    if (benefitUsed > 0) {
      rows.push({
        id: `beneficio-${s.id}`,
        saleId: s.id,
        fecha: s.created_at,
        tipo: 'beneficio_empleado',
        detalle,
        total: benefitUsed,
        metodo: 'beneficio_empleado',
        metodoLabel: HISTORY_PAYMENT_LABELS.beneficio_empleado,
        autorizoCliente: s.employee_name,
        empleadoNombre: s.employee_name || null,
        folio: s.folio,
        items,
        repartidor: null,
        direccion: null,
        telefono: null
      });
    }
  });

  (waste || []).forEach((w) => {
    rows.push({
      id: `waste-${w.id}`,
      saleId: null,
      fecha: w.created_at,
      tipo: w.tipo,
      detalle: w.tipo === 'consumo_interno' ? w.reason : w.item_name,
      total: Number(w.cost) || 0,
      metodo: null,
      metodoLabel: '—',
      autorizoCliente: w.autorizado_por || '—',
      empleadoNombre: w.autorizado_por || null,
      folio: null,
      items: [],
      repartidor: null,
      direccion: null,
      telefono: null
    });
  });

  rows.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

  const kpiScope = rows.filter((r) => {
    if (filters.employeeName && r.empleadoNombre !== filters.employeeName) return false;
    if (filters.paymentMethod && r.metodo !== filters.paymentMethod) return false;
    return true;
  });
  const sumTipo = (tipo) => kpiScope.filter((r) => r.tipo === tipo).reduce((sum, r) => sum + r.total, 0);

  // COGS/margen (reusa computeProfitability, ya construido para Costos):
  // es un agregado de TODA la sucursal en el rango de fechas, no se puede
  // acotar a filters.employeeName/paymentMethod como el resto de los KPIs
  // de arriba (requeriría recalcular costo por renglón sobre ese subconjunto,
  // no solo sumar); se muestra igual, etiquetado como "del rango" en la UI.
  let cogs = 0;
  let grossProfit = 0;
  try {
    const profitability = await computeProfitability(startDate, endDate);
    cogs = profitability.cogs;
    grossProfit = profitability.grossProfit;
  } catch (e) {
    console.warn('No se pudo calcular COGS/margen para el historial:', e.message || e);
  }

  const kpis = {
    ventasTotales: sumTipo('venta') + sumTipo('para_llevar') + sumTipo('domicilio'),
    consumoInterno: sumTipo('consumo_interno'),
    beneficioEmpleados: sumTipo('beneficio_empleado'),
    paraLlevar: sumTipo('para_llevar'),
    domicilio: sumTipo('domicilio'),
    mermaTotal: sumTipo('merma'),
    cogs,
    grossProfit
  };

  const filtered = rows.filter((r) => {
    if (filters.tipo === 'credito_nomina') {
      if (r.metodo !== 'credito_nomina') return false;
    } else if (filters.tipo && filters.tipo !== 'todos' && r.tipo !== filters.tipo) {
      return false;
    }
    if (filters.employeeName && r.empleadoNombre !== filters.employeeName) return false;
    if (filters.paymentMethod && r.metodo !== filters.paymentMethod) return false;
    return true;
  });

  return { rows: filtered, kpis };
}
//===================================================
// 12. AJUSTES
// ==========================================================================
async function getAllSettings() {
  const { data, error } = await supabase
    .from('settings')
    .select('key, value')
    .eq('branch_id', getCurrentBranchId());
  must(error, 'No se pudieron obtener los ajustes');
  const obj = {};
  (data || []).forEach((r) => (obj[r.key] = r.value));
  return obj;
}

// settings ya es por sucursal (branch_id + UNIQUE(key, branch_id), ver
// 20260822050000_settings_branch_isolation.sql). set_setting() (el RPC que
// hacía este upsert) es "caja negra" -- nunca versionado en este repo, no
// se reescribe a ciegas. En vez de eso se hace el upsert directo contra la
// tabla: settings ya tiene RLS abierta a anon desde
// 20260817020000_settings_rls_policy.sql, así que esto no necesita el RPC
// en absoluto y sí queda scoped a la sucursal actual.
async function setSetting(key, value) {
  const { error } = await supabase
    .from('settings')
    .upsert(
      { key, value: String(value), branch_id: getCurrentBranchId() },
      { onConflict: 'key,branch_id' }
    );
  must(error, 'No se pudo guardar el ajuste');
  return true;
}

// Logo del negocio (Ajustes -> SaaS). Sube a Storage (bucket "logos",
// público) bajo una ruta por sucursal, y guarda la URL pública resultante
// como un ajuste normal (logo_url) -- settings ya es por sucursal (ver
// arriba), así que cada sucursal guarda/lee su propio logo.
async function uploadLogo(filePath, originalFileName) {
  const ext = (path.extname(originalFileName || '') || '.png').toLowerCase();
  const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const contentType = MIME_BY_EXT[ext];
  if (!contentType) throw new Error('Formato de imagen no soportado. Usa PNG, JPG o WEBP.');

  const buffer = fs.readFileSync(filePath);
  const storagePath = `${getCurrentBranchId()}/logo-${Date.now()}${ext}`;

  const { error: upErr } = await supabase.storage
    .from('logos')
    .upload(storagePath, buffer, { contentType, upsert: true });
  must(upErr, 'No se pudo subir el logo');

  const { data: pub } = supabase.storage.from('logos').getPublicUrl(storagePath);
  const logoUrl = pub.publicUrl;

  await setSetting('logo_url', logoUrl);
  await setSetting('logo_updated_at', new Date().toISOString());

  return { logoUrl };
}

// Lector de huella biométrico (Ajustes -> Asistencia/Biometría). Igual que
// getPayrollSettings: un valor JSON guardado bajo una sola key de settings.
// Default siempre deshabilitado -- si la key no existe (instalación previa
// a esta función) el sistema sigue en modo manual, no falla.
async function getBiometricSettings() {
  const settings = await getAllSettings();
  let enabled = false;
  let model = 'u_are_u_4500';
  if (settings.biometric_enabled) {
    try {
      const parsed = JSON.parse(settings.biometric_enabled);
      enabled = !!parsed.enabled;
      if (parsed.model) model = parsed.model;
    } catch {
      // valor legado/corrupto: se usa el default (deshabilitado)
    }
  }
  return { enabled, model };
}

async function saveFingerprint(employeeId, template) {
  const { error } = await supabase.rpc('save_fingerprint', {
    p_branch_id: getCurrentBranchId(),
    p_employee_id: employeeId,
    p_template: template
  });
  must(error, 'No se pudo guardar la huella del empleado');
  return true;
}

async function clearFingerprint(employeeId) {
  const { error } = await supabase.rpc('clear_fingerprint', {
    p_branch_id: getCurrentBranchId(),
    p_employee_id: employeeId
  });
  must(error, 'No se pudo borrar la huella del empleado');
  return true;
}

module.exports = {
  init,
  hashPassword,
  makeCredentials,
  getCurrentBranchId,
  setCurrentBranchId,
  getAllBranches,
  subscribeToNewSales,
  // auth / cuentas
  login,
  changePassword,
  getAllUsers,
  createUser,
  updateUser,
  removeUser,
  // productos
  CATEGORY_ALITAS,
  CATEGORY_BONELESS,
  getAllProducts,
  createProduct,
  updateProduct,
  adjustProductStock,
  removeProduct,
  migrateAlitasBonelessCategories,
  // promociones
  getAllPromotions,
  createPromotion,
  updatePromotion,
  removePromotion,
  // ventas
  createSale,
  getSaleById,
  getAllSales,
  getProductsSummary,
  markSalePrinted,
  // comandas
  getTables,
  openTable,
  getOpenSaleByTable,
  getOpenTakeoutOrders,
  openTakeoutOrder,
  comandaSetDeliveryStatus,
  comandaAssignDriver,
  getOpenSaleById,
  comandaAddItem,
  comandaAddItemWithModifiers,
  comandaUpdateItemQty,
  comandaRemoveItem,
  comandaCloseTable,
  comandaCancelTable,
  // modificadores (salsas)
  getModifiers,
  updateModifier,
  getAllProductModifierGroups,
  setProductModifierGroup,
  // combos
  getComponentsForProduct,
  setComponentsForProduct,
  getAllProductComponents,
  // repartidores / liquidación
  getDrivers,
  createDriver,
  getPendingDriverMoney,
  liquidateDriverSales,
  getSalesByPaymentStatus,
  updateSalePaymentStatus,
  // kds
  getKdsOrders,
  updateKdsStatus,
  subscribeToKdsChanges,
  // inventario
  getAllInventory,
  createInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
  addInventoryStock,
  getInventoryMovements,
  checkLowStockInventory,
  // recetas
  getRecipesForProduct,
  setRecipesForProduct,
  getRecipeCost,
  getProductIdsWithRecipe,
  getAllRecipeCosts,
  getAllRecipesWithStock,
  // merma
  getAllWaste,
  createWaste,
  // costos
  getAllCosts,
  createCost,
  removeCost,
  // corte de caja
  getCorteResumen,
  setCashCutFondoInicial,
  createCashMovement,
  removeCashMovement,
  closeCashCut,
  getCashCutsHistory,
  getCorteByFecha,
  // reportes
  computeProfitability,
  // empleados / asistencia
  getAllEmployees,
  createEmployee,
  updateEmployee,
  removeEmployee,
  getTodayAttendance,
  getAllAttendance,
  registerAttendance,
  getEmployeeDailyConsumption,
  // nómina
  getPayrollWeek,
  getPayrollDeductionsPendientes,
  setPayrollBonus,
  getPayrollHistory,
  getWeekRange,
  getPayrollSettings,
  getPayrollData,
  saveBonoAcreditacion,
  getPayrollDetail,
  closePayrollWeek,
  getUnifiedHistory,
  // ajustes
  getAllSettings,
  setSetting,
  // biometría
  getBiometricSettings,
  saveFingerprint,
  clearFingerprint,
  uploadLogo,
  getEmployeeBenefitSettings,
  // roles y permisos
  getRoles,
  createRole,
  updateRole,
  removeRole,
  getRolePermissions,
  setRolePermissions,
  getUserPermissions
};