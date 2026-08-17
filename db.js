// db.js — Capa de datos sobre Supabase (PostgreSQL). Reemplaza el db.js que
// usaba sql.js/SQLite. Expone funciones async con el mismo nombre/forma que
// necesita main.js, para que el resto de la app (preload, renderers, html)
// no tenga que cambiar absolutamente nada.
const crypto = require('crypto');
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
// SUCURSAL — Marina Nacional (id real en la tabla branches). db.js corre en
// el proceso principal de Electron (sin localStorage/DOM); una sola
// instalación sirve una sola sucursal, así que basta una constante. El día
// que haya instalaciones por sucursal, getCurrentBranchId() es el único
// punto a cambiar (ajuste vía settings, por ejemplo).
// ==========================================================================
const DEFAULT_BRANCH_ID = 1; // Marina Nacional
function getCurrentBranchId() {
  return DEFAULT_BRANCH_ID;
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

  return {
    id: user.id,
    username: user.username,
    displayName: user.name,
    role: user.role
  };
}

async function changePassword(userId, newPassword) {
  if (!newPassword || newPassword.length < 4) throw new Error('La contraseña debe tener al menos 4 caracteres.');
  const { salt, hash } = makeCredentials(newPassword);
  // La columna legacy 'password' es NOT NULL en Supabase; se mantiene en
  // sincronía con el hash (no se guarda en texto plano) para no violar la
  // restricción y para que no quede una contraseña anterior obsoleta ahí.
  const { error } = await supabase.from('users').update({ password: hash, password_hash: hash, password_salt: salt }).eq('id', userId);
  must(error, 'No se pudo cambiar la contraseña');
  return true;
}

async function getAllUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('id, username, display_name:name, role, active, created_at')
    .eq('branch_id', getCurrentBranchId())
    .order('role', { ascending: true })
    .order('username', { ascending: true });
  must(error, 'No se pudieron obtener las cuentas');
  return data;
}

async function createUser(data) {
  const username = String(data.username || '').trim().toLowerCase();
  if (!username) throw new Error('El usuario es obligatorio.');
  const { data: existing, error: exErr } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
  must(exErr);
  if (existing) throw new Error('Ese nombre de usuario ya existe.');
  const { salt, hash } = makeCredentials(data.password || '123456');
  const { data: created, error } = await supabase
    .from('users')
    .insert([{
      username,
      name: data.display_name || username,
      role: data.role || 'cajero',
      // Columna legacy NOT NULL en Supabase; se rellena con el hash (no en
      // texto plano) para no violar la restricción sin exponer la contraseña.
      password: hash,
      password_hash: hash,
      password_salt: salt,
      active: data.active !== false,
      branch_id: getCurrentBranchId()
    }])
    .select('id, username, display_name:name, role, active')
    .single();
  must(error, 'No se pudo crear la cuenta');
  return created;
}

async function updateUser(id, data) {
  const patch = {
    name: data.display_name,
    role: data.role || 'cajero',
    active: data.active !== false
  };
  const { error } = await supabase.from('users').update(patch).eq('id', id);
  must(error, 'No se pudo actualizar la cuenta');
  if (data.password) {
    const { salt, hash } = makeCredentials(data.password);
    const { error: pwErr } = await supabase.from('users').update({ password: hash, password_hash: hash, password_salt: salt }).eq('id', id);
    must(pwErr, 'No se pudo actualizar la contraseña');
  }
  const { data: row, error: selErr } = await supabase
    .from('users').select('id, username, display_name:name, role, active').eq('id', id).single();
  must(selErr);
  return row;
}

async function removeUser(id) {
  const { error } = await supabase.from('users').update({ active: false }).eq('id', id);
  must(error, 'No se pudo desactivar la cuenta');
  return { deactivated: true };
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
  const legacyFilter = [
    'category.eq."Alitas y Boneless"',
    'category.eq.alitas',
    'category.eq.boneless'
  ].join(',');

  const { data: rows, error } = await supabase
    .from('products')
    .select('id, name, category')
    .or(legacyFilter);
  must(error, 'No se pudo leer productos para migrar categorías Alitas/Boneless');

  if (!rows || rows.length === 0) return { toAlitas: 0, toBoneless: 0 };

  let toAlitas = 0;
  let toBoneless = 0;
  for (const row of rows) {
    const target = /boneless/i.test(row.name) ? CATEGORY_BONELESS : CATEGORY_ALITAS;
    if (row.category === target) continue;
    const { error: updErr } = await supabase.from('products').update({ category: target }).eq('id', row.id);
    must(updErr, `No se pudo migrar la categoría del producto id=${row.id}`);
    if (target === CATEGORY_BONELESS) {
      toBoneless += 1;
    } else {
      toAlitas += 1;
      console.log(`Migración categorías: producto id=${row.id} "${row.name}" -> Alitas (nombre ambiguo, sin "boneless").`);
    }
  }
  console.log(`Migración categorías Alitas/Boneless: ${toBoneless} producto(s) -> Boneless, ${toAlitas} producto(s) -> Alitas.`);
  return { toAlitas, toBoneless };
}

function normalizeStock(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function getAllProducts() {
  const { data, error } = await supabase
    .from('products').select('*')
    .order('category', { ascending: true })
    .order('sort_order', { ascending: true })
    .order('name', { ascending: true });
  must(error, 'No se pudieron obtener los productos');
  return data;
}

async function createProduct(data) {
  const { data: row, error } = await supabase.from('products').insert([{
    name: data.name,
    category: data.category,
    price: Number(data.price) || 0,
    employee_price: data.employee_price ? Number(data.employee_price) : null,
    active: data.active !== false,
    sort_order: Number(data.sort_order) || 0,
    stock: normalizeStock(data.stock)
  }]).select().single();
  must(error, 'No se pudo crear el producto');
  return row;
}

async function updateProduct(id, data) {
  const { error } = await supabase.from('products').update({
    name: data.name,
    category: data.category,
    price: Number(data.price) || 0,
    employee_price: data.employee_price ? Number(data.employee_price) : null,
    active: data.active !== false,
    sort_order: Number(data.sort_order) || 0,
    stock: normalizeStock(data.stock)
  }).eq('id', id);
  must(error, 'No se pudo actualizar el producto');
  const { data: row, error: selErr } = await supabase.from('products').select('*').eq('id', id).single();
  must(selErr);
  return row;
}

async function adjustProductStock(id, delta) {
  const { data: product, error } = await supabase.from('products').select('*').eq('id', id).single();
  must(error, 'Producto no encontrado');
  if (product.stock === null) return product;
  const newStock = Math.max(0, Number(product.stock) + Number(delta));
  const { data: row, error: updErr } = await supabase.from('products').update({ stock: newStock }).eq('id', id).select().single();
  must(updErr, 'No se pudo ajustar la existencia');
  return row;
}

async function removeProduct(id) {
  const { count, error } = await supabase
    .from('sale_items').select('id', { count: 'exact', head: true }).eq('ref_id', id).eq('item_type', 'product');
  must(error);
  if (count && count > 0) {
    const { error: deErr } = await supabase.from('products').update({ active: false }).eq('id', id);
    must(deErr, 'No se pudo desactivar el producto');
    return { deleted: false, deactivated: true };
  }
  const { error: delErr } = await supabase.from('products').delete().eq('id', id);
  must(delErr, 'No se pudo eliminar el producto');
  return { deleted: true, deactivated: false };
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
  const { data: row, error } = await supabase.from('promotions').insert([{
    name: data.name,
    description: data.description || '',
    price: Number(data.price) || 0,
    active: data.active !== false,
    applicable_category: data.applicable_category || null,
    branch_id: getCurrentBranchId()
  }]).select().single();
  must(error, 'No se pudo crear la promoción');
  return row;
}

async function updatePromotion(id, data) {
  const { error } = await supabase.from('promotions').update({
    name: data.name,
    description: data.description || '',
    price: Number(data.price) || 0,
    active: data.active !== false,
    applicable_category: data.applicable_category || null
  }).eq('id', id);
  must(error, 'No se pudo actualizar la promoción');
  const { data: row, error: selErr } = await supabase.from('promotions').select('*').eq('id', id).single();
  must(selErr);
  return row;
}

async function removePromotion(id) {
  const { count, error } = await supabase
    .from('sale_items').select('id', { count: 'exact', head: true }).eq('ref_id', id).eq('item_type', 'promo');
  must(error);
  if (count && count > 0) {
    const { error: deErr } = await supabase.from('promotions').update({ active: false }).eq('id', id);
    must(deErr, 'No se pudo desactivar la promoción');
    return { deleted: false, deactivated: true };
  }
  const { error: delErr } = await supabase.from('promotions').delete().eq('id', id);
  must(delErr, 'No se pudo eliminar la promoción');
  return { deleted: true, deactivated: false };
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

async function createSale(payload, openedBy, cashierId) {
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error('La venta no contiene artículos.');
  }

  const { data, error } = await supabase.rpc('process_sale', {
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
    p_employee_extra_payment: payload.employeeExtraPayment || null
  });

  must(error, 'No se pudo registrar la venta');

  // process_sale no recibe branch_id/cashier_user_id (branch_id ya se llena
  // solo por el DEFAULT de la columna); se completan aquí sin arriesgar la
  // función de cobro. Si esto falla no se revierte la venta ya cerrada,
  // solo queda sin "Atendió" en el ticket.
  if (cashierId != null) {
    const { error: updErr } = await supabase
      .from('sales')
      .update({ cashier_user_id: cashierId, branch_id: getCurrentBranchId() })
      .eq('id', data.id);
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
        week_end: end
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
  const { data: sale, error } = await supabase.from('sales').select('*').eq('id', id).maybeSingle();
  must(error, 'No se pudo obtener la venta');
  if (!sale) return null;
  const { data: items, error: itErr } = await supabase.from('sale_items').select('*').eq('sale_id', id).order('id');
  must(itErr);

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
  if (filters.dateFrom) query = query.gte('created_at', `${filters.dateFrom}T06:00:00.000Z`);
  if (filters.dateTo) {
    const d = new Date(filters.dateTo);
    d.setDate(d.getDate() + 1);
    const next = d.toISOString().split('T')[0];
    query = query.lt('created_at', `${next}T06:00:00.000Z`);
  }
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
  const fromTs = `${dateFrom}T00:00:00`;
  const toTs = `${dateTo}T23:59:59.999`;
  const { data: items, error } = await supabase
    .from('sale_items').select('name, quantity, subtotal, sales!inner(status, created_at)')
    .eq('sales.status', 'completada').gte('sales.created_at', fromTs).lte('sales.created_at', toTs);
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
  const { error } = await supabase.from('sales').update({ printed: true }).eq('id', id);
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
      { event: 'INSERT', schema: 'public', table: 'sales' },
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
  const { data, error } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
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
  const { data, error } = await supabase.rpc('comanda_open_table', { p_table_number: tableNumber, p_opened_by: openedBy || null });
  must(error, 'No se pudo abrir la mesa');
  return { id: data };
}

async function getOpenSaleByTable(tableNumber) {
  const { data: sale, error } = await supabase.from('sales').select('*')
    .eq('status', 'abierta').eq('table_number', tableNumber).eq('branch_id', getCurrentBranchId()).maybeSingle();
  must(error, 'No se pudo obtener la mesa');
  if (!sale) return null;
  const { data: items, error: itErr } = await supabase.from('sale_items').select('*').eq('sale_id', sale.id).order('id');
  must(itErr);
  return { ...sale, items };
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
  const { data, error } = await supabase.rpc('comanda_open_takeout', { p_opened_by: openedBy || null });
  must(error, 'No se pudo abrir el pedido para llevar');
  return { id: data };
}

// Cambia solo el estado de entrega (pendiente -> en_camino -> entregado).
// No toca driver_name ni el resto de los datos de domicilio: esos se
// capturan una sola vez desde la web (comanda_set_delivery); el escritorio
// solo los muestra y avanza el estado.
// Al llegar a 'entregado' también cierra la venta (status = 'completada'):
// process_sale la insertó como 'abierta' para que fuera visible aquí
// mientras iba en camino (ver 20260816010000_process_sale_delivery_open.sql),
// y hasta este punto debe empezar a contar en reportes / corte de caja.
async function comandaSetDeliveryStatus(saleId, status) {
  if (status !== 'en_camino' && status !== 'entregado') {
    throw new Error(`Estado de entrega inválido: ${status}`);
  }
  const update = { delivery_status: status };
  if (status === 'entregado') update.status = 'completada';
  const { error } = await supabase.from('sales').update(update).eq('id', saleId);
  must(error, 'No se pudo actualizar el estado de entrega');
  return true;
}

async function getOpenSaleById(saleId) {
  const { data: sale, error } = await supabase.from('sales').select('*').eq('id', saleId).maybeSingle();
  must(error, 'No se pudo obtener el pedido');
  if (!sale || sale.status !== 'abierta') return null;
  const { data: items, error: itErr } = await supabase.from('sale_items').select('*').eq('sale_id', sale.id).order('id');
  must(itErr);
  return { ...sale, items };
}

async function comandaAddItem(saleId, item) {
  const { error } = await supabase.rpc('comanda_add_item', {
    p_sale_id: saleId,
    p_ref_id: item.id ?? item.ref_id ?? null,
    p_item_type: item.itemType || item.item_type || 'product',
    p_name: item.name,
    p_unit_price: Number(item.price ?? item.unit_price) || 0,
    p_quantity: Number(item.quantity) || 1
  });
  must(error, 'No se pudo agregar el artículo');
  const { data: sale, error: selErr } = await supabase.from('sales').select('*').eq('id', saleId).single();
  must(selErr);
  return sale;
}

async function comandaUpdateItemQty(itemId, quantity) {
  const { data: saleId, error } = await supabase.rpc('comanda_update_item_qty', { p_item_id: itemId, p_quantity: quantity });
  must(error, 'No se pudo actualizar la cantidad');
  const { data: sale, error: selErr } = await supabase.from('sales').select('*').eq('id', saleId).single();
  must(selErr);
  return sale;
}

async function comandaRemoveItem(itemId) {
  const { data: saleId, error } = await supabase.rpc('comanda_remove_item', { p_item_id: itemId });
  must(error, 'No se pudo quitar el artículo');
  const { data: sale, error: selErr } = await supabase.from('sales').select('*').eq('id', saleId).single();
  must(selErr);
  return sale;
}

async function comandaCloseTable(saleId, payload, openedBy, cashierId) {
  const { data, error } = await supabase.rpc('close_table', {
    p_sale_id: saleId,
    p_discount: Number(payload.discount) || 0,
    p_payment_method: payload.paymentMethod || 'efectivo',
    p_amount_received: payload.amountReceived != null ? Number(payload.amountReceived) : null,
    p_opened_by: openedBy || null
  });
  must(error, 'No se pudo cerrar la mesa');

  if (cashierId != null) {
    const { error: updErr } = await supabase
      .from('sales')
      .update({ cashier_user_id: cashierId, branch_id: getCurrentBranchId() })
      .eq('id', data.id);
    if (updErr) console.error('No se pudo asociar el cajero a la mesa:', updErr.message);
  }

  return { id: data.id, folio: data.folio };
}

async function comandaCancelTable(saleId) {
  const { data: sale, error: selErr } = await supabase.from('sales').select('status').eq('id', saleId).maybeSingle();
  must(selErr);
  if (!sale || sale.status !== 'abierta') throw new Error('Solo se puede cancelar una mesa abierta.');
  const { error } = await supabase.rpc('cancel_table', { p_sale_id: saleId });
  must(error, 'No se pudo cancelar la mesa');
  return { cancelled: true };
}

// ==========================================================================
// 6. INVENTARIO
// ==========================================================================
async function getAllInventory() {
  const { data, error } = await supabase.from('inventory').select('*').eq('branch_id', getCurrentBranchId()).order('name');
  must(error, 'No se pudo obtener el inventario');
  return data;
}

async function createInventoryItem(data) {
  const { data: row, error } = await supabase.from('inventory').insert([{
    name: data.name,
    unit: data.unit || 'pza',
    stock: Number(data.stock) || 0,
    min_stock: Number(data.min_stock) || 0,
    cost_per_unit: Number(data.cost_per_unit) || 0,
    branch_id: getCurrentBranchId()
  }]).select().single();
  must(error, 'No se pudo crear el insumo');
  return row;
}

async function updateInventoryItem(id, data) {
  const { error } = await supabase.from('inventory').update({
    name: data.name,
    unit: data.unit || 'pza',
    stock: Number(data.stock) || 0,
    min_stock: Number(data.min_stock) || 0,
    cost_per_unit: Number(data.cost_per_unit) || 0,
    updated_at: new Date().toISOString()
  }).eq('id', id);
  must(error, 'No se pudo actualizar el insumo');
  const { data: row, error: selErr } = await supabase.from('inventory').select('*').eq('id', id).single();
  must(selErr);
  return row;
}

async function removeInventoryItem(id) {
  const { error: nullErr } = await supabase.from('waste').update({ inventory_id: null }).eq('inventory_id', id);
  must(nullErr);
  const { error } = await supabase.from('inventory').delete().eq('id', id);
  must(error, 'No se pudo eliminar el insumo');
  return { deleted: true };
}

// ==========================================================================
// 7. MERMA
// ==========================================================================
async function getAllWaste(filters = {}) {
  let query = supabase.from('waste').select('*');
  if (filters.dateFrom) query = query.gte('created_at', `${filters.dateFrom}T00:00:00`);
  if (filters.dateTo) query = query.lte('created_at', `${filters.dateTo}T23:59:59.999`);
  if (filters.tipo) query = query.eq('tipo', filters.tipo);
  query = query.order('id', { ascending: false });
  const { data, error } = await query;
  must(error, 'No se pudo obtener la merma');
  return data;
}

async function createWaste(data) {
  let cost = Number(data.cost) || 0;
  let itemName = data.item_name;
  let unit = data.unit || 'pza';
  const tipo = data.tipo === 'consumo_interno' ? 'consumo_interno' : 'merma';
  const autorizadoPor = tipo === 'consumo_interno' ? String(data.autorizado_por || '').trim() : null;
  if (tipo === 'consumo_interno' && !autorizadoPor) {
    throw new Error('Indica qué jefe autoriza el consumo interno.');
  }
  const reason =
    tipo === 'consumo_interno'
      ? `CONSUMO JEFE - ${autorizadoPor} - ${data.reason || 'Sin especificar'}`
      : data.reason || 'Sin especificar';

  if (data.inventory_id) {
    const { data: invItem, error } = await supabase.from('inventory').select('*').eq('id', data.inventory_id).maybeSingle();
    must(error);
    if (invItem) {
      itemName = invItem.name;
      unit = invItem.unit;
      if (!data.cost) cost = invItem.cost_per_unit * Number(data.quantity || 0);
      const newStock = Math.max(0, invItem.stock - Number(data.quantity || 0));
      const { error: updErr } = await supabase.from('inventory')
        .update({ stock: newStock, updated_at: new Date().toISOString() }).eq('id', data.inventory_id);
      must(updErr);
    }
  }

  const { data: row, error: insErr } = await supabase.from('waste').insert([{
    inventory_id: data.inventory_id || null,
    item_name: itemName,
    quantity: Number(data.quantity) || 0,
    unit,
    reason,
    cost,
    tipo,
    autorizado_por: autorizadoPor
  }]).select().single();
  must(insErr, 'No se pudo registrar la merma');
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
  const { data: row, error } = await supabase.from('costs').insert([{
    concept: data.concept,
    category: data.category || 'variable',
    amount: Number(data.amount) || 0,
    date: fallbackDate,
    branch_id: getCurrentBranchId()
  }]).select().single();
  must(error, 'No se pudo registrar el gasto');
  return row;
}

async function removeCost(id) {
  const { error } = await supabase.from('costs').delete().eq('id', id);
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
  // fecha = '2026-08-16' en hora de Xalapa
  // Xalapa 00:00 = UTC 06:00
  const inicioUTC = `${fecha}T06:00:00.000Z`;
  const d = new Date(fecha);
  d.setDate(d.getDate() + 1);
  const fechaSig = d.toISOString().split('T')[0];
  const finUTC = `${fechaSig}T05:59:59.999Z`;

  const { data: sales, error: salesErr } = await supabase
   .from('sales')
   .select('total, delivery_fee, payment_method, status, created_at, client_type, employee_benefit_before, employee_benefit_after')
   .eq('status', 'completada')
   .eq('branch_id', getCurrentBranchId())
   .gte('created_at', inicioUTC)
   .lte('created_at', finUTC);
  must(salesErr, 'No se pudieron obtener las ventas del corte');

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
    movimientos: movimientos || []
  };
}
// Crea/actualiza el fondo inicial del día (upsert por fecha+sucursal: el
// admin puede corregirlo antes de cerrar sin generar renglones duplicados).
async function setCashCutFondoInicial(fecha, fondoInicial) {
  const { data, error } = await supabase
    .from('cash_cuts')
    .upsert(
      { fecha, branch_id: getCurrentBranchId(), fondo_inicial: Number(fondoInicial) || 0 },
      { onConflict: 'fecha,branch_id' }
    )
    .select()
    .single();
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
  const monto = Number(data.monto) || 0;
  const metodoPago = data.metodo_pago || 'efectivo';
  const categoriaCosto = data.categoria_costo || 'otros';

  const { data: row, error } = await supabase
    .from('cash_movements')
    .insert([{
      fecha,
      concepto,
      monto,
      metodo_pago: metodoPago,
      categoria_costo: categoriaCosto,
      branch_id: getCurrentBranchId()
    }])
    .select()
    .single();
  must(error, 'No se pudo registrar la salida de caja');

  const { error: costErr } = await supabase.from('costs').insert([{
    concept: concepto,
    category: mapCashCategoryToCostCategory(categoriaCosto),
    amount: monto,
    date: fecha,
    metodo_pago: metodoPago,
    branch_id: getCurrentBranchId()
  }]);
  // No se revierte cash_movements si esto falla: la salida de caja ya es
  // real y debe quedar registrada aunque el espejo en Costos falle.
  if (costErr) console.error('No se pudo espejar la salida en costs:', costErr.message);

  return row;
}

async function removeCashMovement(id) {
  const { error } = await supabase.from('cash_movements').delete().eq('id', id);
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

  const { data: existing, error: findErr } = await supabase
    .from('cash_cuts')
    .select('id')
    .eq('fecha', fecha)
    .eq('branch_id', getCurrentBranchId())
    .maybeSingle();
  if (findErr) {
    console.error('[closeCashCut] Error buscando corte existente:', findErr);
    throw new Error(`No se pudo cerrar el corte de caja: ${findErr.message}`);
  }

  const payload = {
    fecha,
    branch_id: getCurrentBranchId(),
    fondo_inicial: resumen.fondoInicial,
    efectivo_real: real,
    cerrado_por: cerradoPor,
    cerrado_at: new Date().toISOString()
  };

  // Si ya existe el corte del día (p.ej. se reintentó tras un fallo), se
  // actualiza en vez de intentar un insert que chocaría con el UNIQUE(fecha,
  // branch_id) — no dependemos de upsert/onConflict porque falla en seco si
  // ese constraint no está creado todavía en la base.
  const query = existing
    ? supabase.from('cash_cuts').update(payload).eq('id', existing.id)
    : supabase.from('cash_cuts').insert([payload]);
  const { data, error } = await query.select().single();

  if (error) {
    console.error('[closeCashCut] Error real de Supabase:', {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      fecha,
      branch_id: getCurrentBranchId(),
      existente: !!existing
    });
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
  const fromTs = `${dateFrom}T00:00:00`;
  const toTs = `${dateTo}T23:59:59.999`;

  const { data: sales, error: salesErr } = await supabase
    .from('sales').select('total, payment_method, created_at')
    .eq('status', 'completada').gte('created_at', fromTs).lte('created_at', toTs);
  must(salesErr, 'No se pudo calcular el reporte');

  const { data: wasteRows, error: wasteErr } = await supabase
    .from('waste').select('cost').gte('created_at', fromTs).lte('created_at', toTs);
  must(wasteErr);

  const { data: costRows, error: costErr } = await supabase
    .from('costs').select('amount').gte('date', dateFrom).lte('date', dateTo);
  must(costErr);

  const { data: items, error: itemsErr } = await supabase
    .from('sale_items').select('name, quantity, subtotal, sales!inner(status, created_at)')
    .eq('sales.status', 'completada').gte('sales.created_at', fromTs).lte('sales.created_at', toTs);
  must(itemsErr);

  const totalSales = (sales || []).reduce((sum, s) => sum + Number(s.total || 0), 0);
  const totalTickets = (sales || []).length;
  const totalWaste = (wasteRows || []).reduce((sum, w) => sum + Number(w.cost || 0), 0);
  const totalCosts = (costRows || []).reduce((sum, c) => sum + Number(c.amount || 0), 0);

  const byProduct = {};
  (items || []).forEach((it) => {
    if (!byProduct[it.name]) byProduct[it.name] = { name: it.name, unidades: 0, total: 0 };
    byProduct[it.name].unidades += Number(it.quantity || 0);
    byProduct[it.name].total += Number(it.subtotal || 0);
  });
  const topProducts = Object.values(byProduct).sort((a, b) => b.total - a.total).slice(0, 8);

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
    byPayment: Object.values(byPaymentMap)
  };
}

// ==========================================================================
// 10. EMPLEADOS Y ASISTENCIA
// ==========================================================================
async function getAllEmployees() {
    const { data, error } = await supabase
        .from('employees')
        .select('*')
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
  const { error } = await supabase.from('employees').update({
    name: data.name,
    role: data.role || 'Personal',
    salary: Number(data.salary) || 0,
    weekly_bonus: Number(data.weekly_bonus) || 0,
    active: data.active !== false
  }).eq('id', id);
  must(error, 'No se pudo actualizar el empleado');
  const { data: row, error: selErr } = await supabase.from('employees').select('*').eq('id', id).single();
  must(selErr);
  return row;
}

async function removeEmployee(id) {
  const { count, error } = await supabase.from('attendance').select('id', { count: 'exact', head: true }).eq('employee_id', id);
  must(error);
  if (count && count > 0) {
    const { error: deErr } = await supabase.from('employees').update({ active: false }).eq('id', id);
    must(deErr, 'No se pudo desactivar el empleado');
    return { deleted: false, deactivated: true };
  }
  const { error: delErr } = await supabase.from('employees').delete().eq('id', id);
  must(delErr, 'No se pudo eliminar el empleado');
  return { deleted: true, deactivated: false };
}

function localDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

async function getTodayAttendance() {
  const today = localDateStr();
  const { data, error } = await supabase
    .from('attendance').select('*')
    .eq('branch_id', getCurrentBranchId())
    .gte('timestamp', `${today}T00:00:00`).lte('timestamp', `${today}T23:59:59.999`)
    .order('timestamp', { ascending: false });
  must(error, 'No se pudo obtener la asistencia de hoy');
  return data;
}

async function getAllAttendance(filters = {}) {
  let query = supabase.from('attendance').select('*').eq('branch_id', getCurrentBranchId());
  if (filters.dateFrom) query = query.gte('timestamp', `${filters.dateFrom}T00:00:00`);
  if (filters.dateTo) query = query.lte('timestamp', `${filters.dateTo}T23:59:59.999`);
  query = query.order('timestamp', { ascending: false });
  const { data, error } = await query;
  must(error, 'No se pudo obtener la asistencia');
  return data;
}

async function registerAttendance(employeeId) {
  const { data, error } = await supabase.rpc('register_attendance', { p_employee_id: employeeId });
  must(error, 'No se pudo registrar la asistencia');
  return data;
}

// ==========================================================================
// 11. NÓMINA
// ==========================================================================
async function getPayrollWeek(weekStart) {
  const { data: employees, error } = await supabase.from('employees').select('*').eq('active', true).order('name');
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
    .from('employees').select('*').eq('active', true).order('name');
  must(empErr, 'No se pudieron obtener los empleados');

  const { data: deductions, error: dedErr } = await supabase
    .from('payroll_deductions')
    .select('*')
    .eq('status', 'pendiente')
    .gte('created_at', `${weekStart}T00:00:00`)
    .lte('created_at', `${weekEnd}T23:59:59.999`);
  must(dedErr, 'No se pudieron obtener las deducciones de nómina');

  const { data: attendance, error: attErr } = await supabase
    .from('attendance')
    .select('employee_id, timestamp')
    .gte('timestamp', `${weekStart}T00:00:00`)
    .lte('timestamp', `${weekEnd}T23:59:59.999`);
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
    .gte('created_at', `${weekStart}T00:00:00`)
    .lte('created_at', `${weekEnd}T23:59:59.999`);
  must(consErr, 'No se pudo obtener el beneficio de empleados de la semana');

  const dedByEmployee = {};
  (deductions || []).forEach((d) => {
    const key = d.employee_name;
    if (!dedByEmployee[key]) dedByEmployee[key] = { total: 0, count: 0 };
    dedByEmployee[key].total += Number(d.amount) || 0;
    dedByEmployee[key].count += 1;
  });

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
    const creditos = dedByEmployee[emp.name]?.total || 0;
    const creditosCount = dedByEmployee[emp.name]?.count || 0;
    const tieneHistorialAsistencia = employeesWithAttendanceHistory.has(emp.id);
    const diasAsistidos = attByEmployee[emp.id] || new Set();
    const faltas = tieneHistorialAsistencia ? workDays.filter((d) => !diasAsistidos.has(d)).length : 0;
    const deduccionFaltas = Math.round((salary / faltaDeductionDivisor()) * faltas * 100) / 100;
    const beneficioUsado = benefitByEmployee[emp.id] || 0;
    const totalAPagar = Math.max(salary - creditos - deduccionFaltas, 0);

    return {
      employeeId: emp.id,
      employeeName: emp.name,
      sueldoBase: salary,
      creditos,
      creditosCount,
      faltas,
      deduccionFaltas,
      beneficioUsado,
      totalAPagar,
      sinHistorialAsistencia: !tieneHistorialAsistencia
    };
  });
}

async function getPayrollDetail(employeeName, weekStart, weekEnd) {
  const { data: creditos, error: credErr } = await supabase
    .from('payroll_deductions')
    .select('*')
    .eq('employee_name', employeeName)
    .eq('status', 'pendiente')
    .gte('created_at', `${weekStart}T00:00:00`)
    .lte('created_at', `${weekEnd}T23:59:59.999`)
    .order('created_at', { ascending: false });
  must(credErr, 'No se pudieron obtener los créditos del empleado');

  const { data: employee, error: empErr } = await supabase
    .from('employees').select('id').eq('name', employeeName).maybeSingle();
  must(empErr);

  let faltasDias = [];
  if (employee) {
    const { count: historyCount, error: histErr } = await supabase
      .from('attendance')
      .select('id', { count: 'exact', head: true })
      .eq('employee_id', employee.id);
    must(histErr);

    const { data: attendance, error: attErr } = await supabase
      .from('attendance')
      .select('timestamp')
      .eq('employee_id', employee.id)
      .gte('timestamp', `${weekStart}T00:00:00`)
      .lte('timestamp', `${weekEnd}T23:59:59.999`);
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

  return { creditos: creditos || [], faltasDias };
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
    creditos: r.creditos,
    faltas: r.faltas,
    deduccion_faltas: r.deduccionFaltas,
    beneficio_usado: r.beneficioUsado,
    total_pagado: r.totalAPagar,
    cerrado_por: closedBy || 'admin'
  }));

  if (snapshot.length > 0) {
    const { error: histErr } = await supabase
      .from('payroll_history')
      .upsert(snapshot, { onConflict: 'week_start,employee_id' });
    must(histErr, 'No se pudo guardar el historial de nómina');
  }

  const { error: updErr } = await supabase
    .from('payroll_deductions')
    .update({ status: 'descontado' })
    .eq('status', 'pendiente')
    .gte('created_at', `${weekStart}T00:00:00`)
    .lte('created_at', `${weekEnd}T23:59:59.999`);
  must(updErr, 'No se pudo cerrar la nómina');

  return { closed: true, employees: snapshot.length };
}

// ==========================================================================
// 12. AJUSTES
// ==========================================================================
async function getAllSettings() {
  const { data, error } = await supabase.from('settings').select('key, value');
  must(error, 'No se pudieron obtener los ajustes');
  const obj = {};
  (data || []).forEach((r) => (obj[r.key] = r.value));
  return obj;
}

async function setSetting(key, value) {
  const { error } = await supabase.rpc('set_setting', { p_key: key, p_value: String(value) });
  must(error, 'No se pudo guardar el ajuste');
  return true;
}
module.exports = {
  init,
  hashPassword,
  makeCredentials,
  getCurrentBranchId,
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
  getOpenSaleById,
  comandaAddItem,
  comandaUpdateItemQty,
  comandaRemoveItem,
  comandaCloseTable,
  comandaCancelTable,
  // inventario
  getAllInventory,
  createInventoryItem,
  updateInventoryItem,
  removeInventoryItem,
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
  getPayrollDetail,
  closePayrollWeek,
  // ajustes
  getAllSettings,
  setSetting
};