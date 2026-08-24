// Tests unitarios de la lógica pura de db.js -- sin red, sin Supabase, sin
// Electron. Corren en cada push (ver .github/workflows/test.yml). No
// cubren nada que dependa de la base de datos real (login, RLS,
// aislamiento por sucursal) -- eso queda en scripts/verify-branch-
// isolation.js, que se corre a mano a propósito (ver ese archivo).
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

test('hashPassword / makeCredentials', async (t) => {
  await t.test('la misma password+salt siempre da el mismo hash', () => {
    const salt = 'abc123';
    assert.equal(db.hashPassword('miPassword', salt), db.hashPassword('miPassword', salt));
  });

  await t.test('salts distintos dan hashes distintos para la misma password', () => {
    assert.notEqual(db.hashPassword('miPassword', 'saltA'), db.hashPassword('miPassword', 'saltB'));
  });

  await t.test('el hash es hex de 64 bytes (128 caracteres)', () => {
    const hash = db.hashPassword('x', 'y');
    assert.match(hash, /^[0-9a-f]{128}$/);
  });

  await t.test('makeCredentials genera un salt distinto cada vez', () => {
    const a = db.makeCredentials('pw');
    const b = db.makeCredentials('pw');
    assert.notEqual(a.salt, b.salt);
    assert.equal(db.hashPassword('pw', a.salt), a.hash);
  });
});

test('localDateStr', async (t) => {
  await t.test('formatea YYYY-MM-DD con ceros a la izquierda', () => {
    assert.equal(db.localDateStr(new Date(2026, 0, 5)), '2026-01-05');
  });

  await t.test('funciona en fin de mes/año', () => {
    assert.equal(db.localDateStr(new Date(2026, 11, 31)), '2026-12-31');
  });
});

test('getWeekRange -- semana laboral configurable por día de pago', async (t) => {
  await t.test('payday sábado: la semana es domingo a sábado', () => {
    // 2026-01-17 es sábado.
    const { start, end } = db.getWeekRange(6, '2026-01-17');
    assert.equal(start, '2026-01-11'); // domingo
    assert.equal(end, '2026-01-17'); // sábado (el propio payday)
  });

  await t.test('el día siguiente al payday ya es la semana NUEVA, no la que acaba de cerrar', () => {
    // Bug real documentado en el código: si esto se calculara mal, el
    // domingo posterior a un payday sábado quedaría agrupado con la
    // semana ya cerrada en vez de abrir la siguiente.
    const { start, end } = db.getWeekRange(6, '2026-01-18'); // domingo siguiente
    assert.equal(start, '2026-01-18');
    assert.equal(end, '2026-01-24');
  });

  await t.test('payday domingo: la semana es lunes a domingo', () => {
    const { start, end } = db.getWeekRange(0, '2026-01-14'); // miércoles
    assert.equal(start, '2026-01-12'); // lunes
    assert.equal(end, '2026-01-18'); // domingo
  });

  await t.test('sin paydayNumber válido, cae a sábado (default)', () => {
    const conDefault = db.getWeekRange(undefined, '2026-01-17');
    const explicitoSabado = db.getWeekRange(6, '2026-01-17');
    assert.deepEqual(conDefault, explicitoSabado);
  });
});

test('isoMondayOf -- lunes ISO de la semana que contiene la fecha', async (t) => {
  await t.test('domingo retrocede 6 días al lunes anterior', () => {
    assert.equal(db.isoMondayOf('2026-01-18'), '2026-01-12'); // domingo -> lunes anterior
  });

  await t.test('un lunes se queda igual', () => {
    assert.equal(db.isoMondayOf('2026-01-12'), '2026-01-12');
  });

  await t.test('miércoles retrocede al lunes de esa misma semana', () => {
    assert.equal(db.isoMondayOf('2026-01-14'), '2026-01-12');
  });
});

test('normalizeStock', async (t) => {
  await t.test('undefined/null/vacío -> null', () => {
    assert.equal(db.normalizeStock(undefined), null);
    assert.equal(db.normalizeStock(null), null);
    assert.equal(db.normalizeStock(''), null);
  });

  await t.test('cero es un valor válido, NO null', () => {
    assert.equal(db.normalizeStock(0), 0);
    assert.equal(db.normalizeStock('0'), 0);
  });

  await t.test('string numérico se convierte a number', () => {
    assert.equal(db.normalizeStock('5.5'), 5.5);
  });

  await t.test('no numérico -> null', () => {
    assert.equal(db.normalizeStock('abc'), null);
  });
});

test('mapCartItems', async (t) => {
  await t.test('mapea id/itemType (camelCase del cliente) con fallback a ref_id/item_type', () => {
    const [row] = db.mapCartItems([{ id: 7, itemType: 'promo', name: 'Combo', price: 120, quantity: 2 }]);
    assert.deepEqual(row, { ref_id: 7, item_type: 'promo', name: 'Combo', unit_price: 120, quantity: 2 });
  });

  await t.test('defaults: item_type=product, quantity=1, unit_price=0', () => {
    const [row] = db.mapCartItems([{ name: 'Suelto' }]);
    assert.equal(row.item_type, 'product');
    assert.equal(row.quantity, 1);
    assert.equal(row.unit_price, 0);
  });

  await t.test('lista vacía/null -> []', () => {
    assert.deepEqual(db.mapCartItems([]), []);
    assert.deepEqual(db.mapCartItems(null), []);
  });
});

test('saleHistoryTipo', async (t) => {
  await t.test('para llevar sin delivery -> para_llevar', () => {
    assert.equal(db.saleHistoryTipo({ client_type: 'Para Llevar', is_delivery: false }), 'para_llevar');
  });

  await t.test('para llevar con delivery -> domicilio', () => {
    assert.equal(db.saleHistoryTipo({ client_type: 'llevar', is_delivery: true }), 'domicilio');
  });

  await t.test('cualquier otro client_type -> venta', () => {
    assert.equal(db.saleHistoryTipo({ client_type: 'Mesa' }), 'venta');
    assert.equal(db.saleHistoryTipo({ client_type: 'Mostrador' }), 'venta');
  });
});

test('normalizeHistoryDate', async (t) => {
  await t.test('DD/MM/YYYY -> YYYY-MM-DD', () => {
    assert.equal(db.normalizeHistoryDate('05/01/2026'), '2026-01-05');
  });

  await t.test('ya viene en formato ISO -> se recorta a 10 caracteres', () => {
    assert.equal(db.normalizeHistoryDate('2026-01-05T10:30:00Z'), '2026-01-05');
  });

  await t.test('vacío/null -> null', () => {
    assert.equal(db.normalizeHistoryDate(''), null);
    assert.equal(db.normalizeHistoryDate(null), null);
  });
});

test('localDayStartUtcIso / localDayEndUtcIso', async (t) => {
  await t.test('el rango cubre exactamente un día completo (86400000ms - 1ms)', () => {
    const startMs = new Date(db.localDayStartUtcIso('2026-06-15')).getTime();
    const endMs = new Date(db.localDayEndUtcIso('2026-06-15')).getTime();
    assert.equal(endMs - startMs, 86400000 - 1);
  });

  await t.test('start es anterior a end', () => {
    const start = new Date(db.localDayStartUtcIso('2026-06-15')).getTime();
    const end = new Date(db.localDayEndUtcIso('2026-06-15')).getTime();
    assert.ok(start < end);
  });
});

test('setCurrentBranchId / getCurrentBranchId', async (t) => {
  await t.test('rechaza valores inválidos', () => {
    assert.throws(() => db.setCurrentBranchId(0));
    assert.throws(() => db.setCurrentBranchId(-1));
    assert.throws(() => db.setCurrentBranchId('abc'));
    assert.throws(() => db.setCurrentBranchId(null));
  });

  await t.test('acepta un entero positivo y getCurrentBranchId lo devuelve', () => {
    db.setCurrentBranchId(1);
    assert.equal(db.getCurrentBranchId(), 1);
    db.setCurrentBranchId('2'); // string numérico, como llega de IPC/config
    assert.equal(db.getCurrentBranchId(), 2);
  });
});
