// Onboarding asistido v1 -- CLI para dar de alta un negocio nuevo (tenant).
//
// Uso:
//   node scripts/onboard-tenant.js --name "Tacos Pepe" --email dueno@tacos.com --password Temp123! --branch "Matriz"
//   node scripts/onboard-tenant.js --help
//
// Corre con SUPABASE_SERVICE_ROLE_KEY (bypasea RLS por diseño -- es una
// herramienta de operador, nunca se empaqueta en el .exe ni en el bundle
// web). Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno o
// en .env -- la service role key NUNCA tiene un default hardcodeado aquí
// (a diferencia de la anon key en supabaseConfig.js, que sí es segura de
// exponer).
//
// Nota sobre el esquema real vs. lo pedido originalmente (verificado en
// vivo antes de escribir esto, no adivinado):
//   - tenants.id es bigint IDENTITY, no uuid (ver 20260822110000_tenants_scaffolding.sql).
//   - branches.tenant_id ya existe y es NOT NULL (mismo archivo) -- no se
//     toca su nullability, y no hace falta "crear la tabla si no existe":
//     tenants/branches ya existen. Un script con supabase-js tampoco puede
//     correr CREATE TABLE de todos modos (eso es DDL, requiere una
//     migración) -- si algún día faltara la tabla, este script lo va a
//     reportar como error claro, no a intentar crearla.
//   - `settings` es key-value (key, value, branch_id) -- NO tiene columnas
//     business_name/logo_url/tenant_id. Se insertan como filas normales,
//     mismo shape que usa el resto de la app (ver common.js::loadAndApplyBranding).
//     No se le agrega tenant_id a settings: el tenant ya se deriva de
//     branch_id -> branches.tenant_id en todos lados (current_branch_id()),
//     agregarlo aquí sería redundante -- mismo razonamiento que
//     20260822140000_tenant_active_enforcement.sql ya documentó para no
//     comparar branch_id contra tenant_id dos veces.
//   - El secreto de KDS vive en `branch_kds_secrets` (branch_id, secret),
//     no en una columna de `branches` -- ver 20260822190000_kds_secret_hotfix.sql.
//   - `users` no tiene columna tenant_id -- se deriva vía branch_id, igual
//     que todo lo demás.
//
// Sin librería de parseo de argumentos nueva (no hay ninguna en
// package.json hoy -- mismo criterio "sin dependencias nuevas" que el
// resto del repo).

require('dotenv').config();
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Sucursal de la que se copian los nombres de salsa (modifiers,
// group_name='Salsas') para que un tenant nuevo no arranque con el
// selector de salsa de Ventas vacío -- ver bug 2026-08-29 (ver
// 20260829020000_create_modifier_rpc.sql). Es la sucursal original de
// antes de que el catálogo fuera multi-tenant (el "DEFAULT_BRANCH_ID=1"
// hardcodeado que main.js:86 documenta haber reemplazado), la única que
// hoy tiene esas 9 salsas cargadas. Solo se copian nombre/grupo/precio
// extra/cantidad por porción -- NUNCA inventory_id: el insumo de la
// sucursal 1 no existe en el tenant nuevo (inventory también es por
// sucursal), así que cada modificador queda "Sin vincular" hasta que el
// dueño lo ligue a su propio insumo desde Catálogo > Modificadores, igual
// que ya tiene que hacer para cualquier modificador nuevo.
const SEED_SAUCES_BRANCH_ID = 1;

const HELP = `
Onboarding asistido v1 -- da de alta un negocio (tenant) nuevo.

Uso:
  node scripts/onboard-tenant.js --name "Tacos Pepe" --email dueno@tacos.com --password Temp123! --branch "Matriz"

Flags:
  --name       Nombre del negocio (tenant). Obligatorio.
  --email      Correo del dueño, para iniciar sesión. Obligatorio.
  --password   Contraseña inicial del dueño (mínimo 8 caracteres). Obligatorio.
  --branch     Nombre de la primera sucursal. Obligatorio.
  --help, -h   Muestra esta ayuda y sale.

Requiere en el entorno (o en .env):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY   (Project Settings -> API -> service_role, NUNCA la anon key)

Si ya existe un tenant con ese nombre, el script aborta sin crear nada.
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    const m = /^--([a-z]+)$/.exec(a);
    if (!m) continue;
    out[m[1]] = argv[i + 1];
    i++;
  }
  return out;
}

// Idéntico a hashPassword()/makeCredentials() en db.js y en
// supabase/functions/login/index.ts -- misma sal (hex de 16 bytes, usada
// tal cual como string) y mismo scrypt(password, salt, 64). El login real
// de la app (Edge Function `login`) verifica la contraseña contra
// users.password_hash/password_salt, NO contra la contraseña de
// auth.users -- así que este hash es el que de verdad importa para poder
// entrar.
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function makeCredentials(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPassword(password, salt) };
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos (marcas diacríticas combinantes)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'tenant';
}

async function uniqueSlug(admin, baseName) {
  const base = slugify(baseName);
  let slug = base;
  let n = 1;
  // Los tenants de prueba son pocos -- un loop secuencial es más que
  // suficiente, no hace falta nada más elaborado.
  for (;;) {
    const { data, error } = await admin.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (error) throw new Error(`No se pudo verificar el slug: ${error.message}`);
    if (!data) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const missing = ['name', 'email', 'password', 'branch'].filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(`Faltan parámetros obligatorios: ${missing.map((k) => '--' + k).join(', ')}`);
    console.log(HELP);
    process.exit(1);
  }

  if (String(args.password).length < 8) {
    console.error('La contraseña debe tener al menos 8 caracteres.');
    process.exit(1);
  }

  const SUPABASE_URL = process.env.SUPABASE_URL || require('../supabaseConfig').SUPABASE_URL;
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SERVICE_ROLE_KEY) {
    console.error(
      'Falta SUPABASE_SERVICE_ROLE_KEY en el entorno/.env. ' +
      'Este script necesita la service_role key (Project Settings -> API en el dashboard de Supabase) -- ' +
      'la anon key no alcanza para crear usuarios de Auth ni saltarse RLS.'
    );
    process.exit(1);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const businessName = String(args.name).trim();
  const branchName = String(args.branch).trim();
  const email = String(args.email).trim().toLowerCase();
  const password = String(args.password);

  console.log(`\nDando de alta "${businessName}"...\n`);

  try {
    // 1. Aborta si ya existe un tenant con ese nombre.
    const { data: existingTenant, error: existErr } = await admin
      .from('tenants').select('id').eq('name', businessName).maybeSingle();
    if (existErr) throw new Error(`No se pudo verificar tenants existentes: ${existErr.message}`);
    if (existingTenant) {
      console.error(`Ya existe un tenant llamado "${businessName}" (id ${existingTenant.id}). Abortando -- no se creó nada.`);
      process.exit(1);
    }

    // 2. Crea el tenant.
    const slug = await uniqueSlug(admin, businessName);
    const { data: tenant, error: tenantErr } = await admin
      .from('tenants').insert({ name: businessName, slug, active: true }).select().single();
    if (tenantErr) throw new Error(`No se pudo crear el tenant: ${tenantErr.message}`);
    console.log(`✔ Tenant creado (id ${tenant.id}, slug "${tenant.slug}")`);

    // 3. Crea la primera sucursal.
    const { data: branch, error: branchErr } = await admin
      .from('branches').insert({ name: branchName, tenant_id: tenant.id }).select().single();
    if (branchErr) throw new Error(`No se pudo crear la sucursal: ${branchErr.message}`);
    console.log(`✔ Sucursal creada (id ${branch.id}, "${branch.name}")`);

    // 4. Secreto de KDS (ver 20260822190000_kds_secret_hotfix.sql) -- se
    // instala a mano en branch-config.json del PC de KDS de esa sucursal,
    // no hay onboarding automático de eso todavía.
    const kdsSecret = crypto.randomBytes(32).toString('hex');
    const { error: secretErr } = await admin
      .from('branch_kds_secrets').insert({ branch_id: branch.id, secret: kdsSecret });
    if (secretErr) throw new Error(`No se pudo crear el secreto de KDS: ${secretErr.message}`);
    console.log('✔ Secreto de KDS generado');

    // 5. Usuario de Supabase Auth -- necesario para que auth_user_id tenga
    // a qué apuntar (current_branch_id() depende de eso). La contraseña
    // real que la app valida es la de public.users (paso 6) -- la Edge
    // Function `login` nunca compara contra la contraseña de auth.users,
    // así que esta es principalmente para tener el vínculo, no para el
    // login del día a día.
    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });
    if (authErr) throw new Error(`No se pudo crear el usuario de Auth: ${authErr.message}`);
    console.log(`✔ Usuario de Supabase Auth creado (${authUser.user.id})`);

    // 6. Fila real en public.users -- mismo scrypt+sal que usa el resto de
    // la app, role='admin' (bypasea el sistema de permisos granulares por
    // módulo, ver hasPermission() en common.js -- correcto para el dueño).
    const { salt, hash } = makeCredentials(password);
    const username = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '') || `owner${branch.id}`;
    const { data: userRow, error: userErr } = await admin.from('users').insert({
      username,
      name: 'Dueño',
      role: 'admin',
      password_hash: hash,
      password_salt: salt,
      branch_id: branch.id,
      active: true,
      email,
      auth_user_id: authUser.user.id
    }).select().single();
    if (userErr) throw new Error(`No se pudo crear el usuario en public.users: ${userErr.message}`);
    console.log(`✔ Cuenta de administrador creada (username "${userRow.username}")`);

    // 7. Ajustes iniciales -- filas key-value, mismo shape que
    // common.js::loadAndApplyBranding ya lee (business_name/logo_url/
    // theme_auto). logo_url se deja sin fila (NULL = "usa el logo
    // default") en vez de insertar un NULL literal -- mismo criterio que
    // el resto de settings (ausente = sin override).
    const initialSettings = [
      { key: 'business_name', value: businessName },
      { key: 'theme_auto', value: 'false' }
    ];
    for (const s of initialSettings) {
      const { error: setErr } = await admin.from('settings').insert({ ...s, branch_id: branch.id });
      if (setErr) throw new Error(`No se pudo guardar el ajuste "${s.key}": ${setErr.message}`);
    }
    console.log('✔ Ajustes iniciales guardados (nombre del negocio, colores default)');

    // 8. Salsas iniciales -- copia solo nombre/grupo/precio extra/cantidad
    // por porción de SEED_SAUCES_BRANCH_ID, sin inventory_id (ver
    // comentario de la constante). Best-effort: si esa sucursal no existe
    // en este entorno (p.ej. base de pruebas nueva) o ya no tiene salsas,
    // no aborta el onboarding -- el dueño puede crearlas a mano desde
    // Catálogo > Modificadores ("+ Nuevo modificador").
    const { data: seedModifiers, error: seedErr } = await admin
      .from('modifiers').select('name, group_name, price_extra, qty_needed')
      .eq('branch_id', SEED_SAUCES_BRANCH_ID).eq('active', true);
    if (seedErr) {
      console.warn(`⚠ No se pudieron leer las salsas de la sucursal ${SEED_SAUCES_BRANCH_ID}: ${seedErr.message}`);
    } else if (!seedModifiers || seedModifiers.length === 0) {
      console.warn(`⚠ La sucursal ${SEED_SAUCES_BRANCH_ID} no tiene salsas que copiar.`);
    } else {
      const rows = seedModifiers.map((m) => ({
        name: m.name,
        group_name: m.group_name,
        price_extra: m.price_extra,
        qty_needed: m.qty_needed,
        is_required: false,
        is_active: true,
        active: true,
        inventory_id: null,
        branch_id: branch.id
      }));
      const { error: insertErr } = await admin.from('modifiers').insert(rows);
      if (insertErr) {
        console.warn(`⚠ No se pudieron copiar las salsas: ${insertErr.message}`);
      } else {
        console.log(`✔ ${rows.length} salsas copiadas (sin insumo vinculado -- liga cada una desde Catálogo > Modificadores)`);
      }
    }

    console.log('\n--- Listo ---');
    console.log(`TENANT_ID: ${tenant.id}`);
    console.log(`BRANCH_ID: ${branch.id}`);
    console.log(`KDS_SECRET: ${kdsSecret}`);
    console.log(`LOGIN: ${email} / ${password}`);
    console.log('INSTALADOR: dist/sucursal-setup.exe');
    console.log('');
    console.log('Pendiente manual: al configurar el PC de esta sucursal, si va a tener');
    console.log('TV de cocina sin login, agregar "kdsSecret" (el valor de arriba) a su');
    console.log('branch-config.json -- ver 20260822190000_kds_secret_hotfix.sql.');
  } catch (err) {
    console.error(`\n✖ ${err.message}`);
    console.error('\nEl onboarding se detuvo a medias -- revisa arriba qué pasos ya se completaron');
    console.error('(quedaron creados en Supabase) antes de reintentar, para no duplicar tenant/sucursal.');
    process.exit(1);
  }
}

main();
