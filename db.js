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
  if (filters.dateFrom) query = query.gte('created_at', `${filters.dateFrom}T00:00:00`);
  if (filters.dateTo) query = query.lte('created_at', `${filters.dateTo}T23:59:59.999`);
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
  query = query.order('id', { ascending: false });
  const { data, error } = await query;
  must(error, 'No se pudo obtener la merma');
  return data;
}

async function createWaste(data) {
  let cost = Number(data.cost) || 0;
  let itemName = data.item_name;
  let unit = data.unit || 'pza';

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
    reason: data.reason || 'Sin especificar',
    cost
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
  setPayrollBonus,
  getPayrollHistory,
  // ajustes
  getAllSettings,
  setSetting
};