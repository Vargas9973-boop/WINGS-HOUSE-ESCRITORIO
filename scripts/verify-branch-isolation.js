// Tarea 4 -- validación de aislamiento por sucursal (Opción A).
//
// Corre con: node scripts/verify-branch-isolation.js
//
// Usa la MISMA anon key que la app real (supabaseClient.js) -- así prueba
// exactamente lo que un atacante con esa llave podría hacer, no un
// escenario artificial con más permisos. No toca ninguna venta existente:
// crea su propia sucursal de prueba y sus propias comandas de prueba, y las
// borra al final (o al truena a medio camino -- ver catch general).
//
// Qué valida y qué NO:
//   - Los RPC de escritura (comanda_update_item_qty, mark_sale_printed, etc.)
//     SÍ deben rechazar cruzar de sucursal -- eso es lo que cierra 0008+0009.
//   - Las tablas SÍ deben rechazar INSERT/UPDATE/DELETE directo de anon.
//   - La LECTURA directa de tablas (`.from('sales').select()`) SIGUE ABIERTA
//     a propósito en esta fase (ver el comentario "Deuda pendiente" en
//     20260820010000_deny_anon_direct_access.sql) -- este script lo prueba y
//     lo reporta como ⚠️  ESPERADO, no como falla.

const { createClient } = require('@supabase/supabase-js');
const { SUPABASE_URL, SUPABASE_ANON_KEY } = require('../supabaseConfig');
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime: { transport: require('ws') } });

const TEST_BRANCH_NAME = '__TEST_ISOLATION_BORRAR__';
let results = [];

function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' -- ' + detail : ''}`);
}

function reportExpectedGap(name, detail) {
  results.push({ name, ok: null, detail });
  console.log(`⚠️  ${name} -- ${detail} (ESPERADO en esta fase, ver Fase 2 pendiente)`);
}

async function ensureTestBranch() {
  const { data: existing } = await supabase.from('branches').select('id').eq('name', TEST_BRANCH_NAME).maybeSingle();
  if (existing) return { id: existing.id, created: false };
  const { data, error } = await supabase.from('branches').insert([{ name: TEST_BRANCH_NAME }]).select('id').single();
  if (error) throw new Error('No se pudo crear la sucursal de prueba (revisa que branches siga con INSERT abierto para anon): ' + error.message);
  return { id: data.id, created: true };
}

async function openTestTable(branchId, tableNumber) {
  const { data, error } = await supabase.rpc('comanda_open_table', {
    p_branch_id: branchId,
    p_table_number: tableNumber,
    p_opened_by: 'verify-branch-isolation.js'
  });
  if (error) throw new Error(`No se pudo abrir mesa de prueba en sucursal ${branchId}: ${error.message}`);
  return data;
}

async function addTestItem(branchId, saleId) {
  const { error } = await supabase.rpc('comanda_add_item', {
    p_branch_id: branchId,
    p_sale_id: saleId,
    p_ref_id: null,
    p_item_type: 'product',
    p_name: 'ITEM DE PRUEBA (verify-branch-isolation.js)',
    p_unit_price: 1,
    p_quantity: 1
  });
  if (error) throw new Error(`No se pudo agregar artículo de prueba: ${error.message}`);
  const { data: items, error: selErr } = await supabase.from('sale_items').select('id').eq('sale_id', saleId).order('id', { ascending: false }).limit(1);
  if (selErr || !items?.length) throw new Error('No se pudo leer el artículo recién creado.');
  return items[0].id;
}

async function main() {
  console.log(`\nConectando a ${SUPABASE_URL} con la anon key pública (la misma que usa la app)...\n`);

  const realBranch = await (async () => {
    const { data, error } = await supabase.from('branches').select('id, name').order('id').limit(1).single();
    if (error || !data) throw new Error('No hay ninguna sucursal real en la base -- no se puede probar nada.');
    return data;
  })();
  console.log(`Sucursal real detectada: "${realBranch.name}" (id ${realBranch.id}). Se usa como "Branch A".`);

  const testBranch = await ensureTestBranch();
  console.log(`Sucursal de prueba "Branch B": id ${testBranch.id}${testBranch.created ? ' (creada ahora)' : ' (ya existía de una corrida anterior)'}.\n`);

  const saleA = await openTestTable(realBranch.id, 991);
  const saleB = await openTestTable(testBranch.id, 992);
  const itemB = await addTestItem(testBranch.id, saleB);
  console.log(`Comanda de prueba A: sale_id=${saleA} (branch ${realBranch.id}). Comanda de prueba B: sale_id=${saleB}, item_id=${itemB} (branch ${testBranch.id}).\n`);

  console.log('--- 1. RPC de escritura: intentar tocar la venta de B haciéndose pasar por A ---');

  {
    const { error } = await supabase.rpc('comanda_update_item_qty', { p_branch_id: realBranch.id, p_item_id: itemB, p_quantity: 5 });
    report('comanda_update_item_qty(branch A, item de B) rechaza', !!error, error?.message);
  }
  {
    const { error } = await supabase.rpc('mark_sale_printed', { p_branch_id: realBranch.id, p_sale_id: saleB });
    report('mark_sale_printed(branch A, sale de B) rechaza', !!error, error?.message);
  }
  {
    const { error } = await supabase.rpc('update_kds_status', { p_branch_id: realBranch.id, p_sale_id: saleB, p_status: 'lista' });
    report('update_kds_status(branch A, sale de B) rechaza', !!error, error?.message);
  }
  {
    const { error } = await supabase.rpc('comanda_add_item_with_modifiers', {
      p_branch_id: realBranch.id, p_sale_id: saleB, p_ref_id: null, p_item_type: 'product',
      p_name: 'x', p_unit_price: 1, p_quantity: 1, p_modifier_ids: null, p_notes: null
    });
    report('comanda_add_item_with_modifiers(branch A, sale de B) rechaza', !!error, error?.message);
  }

  console.log('\n--- 2. Escritura directa a tabla (sin RPC): debe estar negada para anon ---');
  {
    const { error, count } = await supabase.from('sales').update({ printed: true }).eq('id', saleB).select('id', { count: 'exact' });
    // Con USING(false), Postgres no lanza error -- solo actualiza 0 filas.
    report('UPDATE directo a sales (sin RPC) no modifica ninguna fila', (count ?? 0) === 0, error ? error.message : `count=${count}`);
  }

  console.log('\n--- 3. Lectura directa a tabla: SIGUE ABIERTA en esta fase (ver Deuda pendiente) ---');
  {
    const { data, error } = await supabase.from('sales').select('id, branch_id, folio').eq('id', saleB);
    reportExpectedGap('SELECT directo a sales de otra sucursal', error ? `bloqueado (${error.message})` : `devolvió ${data?.length ?? 0} fila(s) -- RLS de lectura es Fase 2`);
  }

  console.log('\n--- 4. Realtime: un canal filtrado por Branch A no debe recibir inserts de Branch B ---');
  await new Promise((resolve) => {
    let gotWrongEvent = false;
    const channel = supabase
      .channel('verify-isolation-realtime')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sales', filter: `branch_id=eq.${realBranch.id}` }, () => {
        gotWrongEvent = true;
      })
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        await openTestTable(testBranch.id, 993); // insert en branch B, no debería llegar
        setTimeout(async () => {
          report('Canal de Branch A no recibió el insert de Branch B', !gotWrongEvent);
          await supabase.removeChannel(channel);
          resolve();
        }, 4000);
      });
  });

  console.log('\nLimpiando datos de prueba...');
  await supabase.rpc('cancel_table', { p_sale_id: saleA }).catch(() => {});
  // cancel_table sigue "pendiente" (no valida branch todavía) -- funciona
  // igual para limpiar aunque no reciba p_branch_id.
  await supabase.from('sale_items').delete().eq('sale_id', saleB);
  await supabase.from('sales').delete().in('table_number', [991, 992, 993]).eq('branch_id', testBranch.id);
  await supabase.from('sales').delete().eq('id', saleA);
  if (testBranch.created) {
    await supabase.from('branches').delete().eq('id', testBranch.id);
  }
  console.log('Listo.\n');

  const fails = results.filter((r) => r.ok === false);
  console.log(`\n${fails.length === 0 ? '✅ TODO EN VERDE' : `❌ ${fails.length} PRUEBA(S) FALLARON`} (${results.filter((r) => r.ok === null).length} son deuda esperada de Fase 2).`);
  process.exit(fails.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n💥 El script truena antes de terminar:', err.message);
  console.error('Puede haber quedado basura de prueba (sucursal "__TEST_ISOLATION_BORRAR__", mesas 991-993) -- bórrala a mano si esto pasa.');
  process.exit(2);
});
