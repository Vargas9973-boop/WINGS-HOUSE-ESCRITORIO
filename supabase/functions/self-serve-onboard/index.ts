// Alta de tenant self-serve (wing-house-web/saas-panel) -- hermano de
// onboard-tenant (panel SuperAdmin), pero aquí quien da de alta el negocio
// es el propio dueño, autenticado con Google vía Supabase Auth. Mismo
// resultado final (tenant + sucursal + secreto de KDS + usuario admin),
// con 3 diferencias clave:
//
//  - Autorización: solo exige una sesión válida (cualquier auth.users con
//    JWT vigente), no is_superadmin() -- este endpoint es público a
//    propósito, cualquiera que inicie sesión con Google puede darse de
//    alta un negocio.
//  - No crea un auth.users nuevo -- reutiliza el que ya generó el login
//    con Google (auth_user_id = caller.id). La contraseña que se genera
//    aquí es solo para el login del sistema de escritorio
//    (username+password contra public.users, ver supabase/functions/login)
//    -- la web sigue entrando con Google.
//  - El plan (precio/tipo de cobro/módulos) se resuelve del catálogo
//    compartido _shared/plans.ts, nunca de lo que mande el body -- si no,
//    cualquiera podría mandar price:0 en la llamada. plan_id se guarda en
//    tenants para que login (Edge Function) sepa qué módulos habilitar
//    (ver 20260905000000_tenants_plan_id.sql).
//
// PRECIOS/MÓDULOS POR PLAN SON PROVISIONALES -- pendiente de aterrizar (ver
// conversación con el dueño del proyecto, 2026-09-05). "Confirmar pago" en
// el frontend hoy es un botón simulado, no cobra nada de verdad todavía --
// por eso billing_status queda 'active' de una vez. Cuando se conecte un
// procesador real, este es el único lugar que hay que tocar para que el
// alta quede condicionada a un pago verificado en vez de a un clic.
import { createClient } from "npm:@supabase/supabase-js@2";
import { scryptSync } from "node:crypto";
import { isValidPlanId, PLAN_CATALOG } from "../_shared/plans.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Idéntico a hashPassword()/makeCredentials() en login/index.ts y
// onboard-tenant/index.ts (scrypt+sal).
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function makeCredentials(password: string): { salt: string; hash: string } {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { salt, hash: hashPassword(password, salt) };
}

// Sin 0/O/1/l/I -- para que se pueda transcribir a mano sin ambigüedad si
// hace falta.
function makePassword(length = 12): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "tenant";
}

async function uniqueSlug(admin: ReturnType<typeof createClient>, baseName: string): Promise<string> {
  const base = slugify(baseName);
  let slug = base;
  let n = 1;
  for (;;) {
    const { data, error } = await admin.from("tenants").select("id").eq("slug", slug).maybeSingle();
    if (error) throw new Error(`No se pudo verificar el slug: ${error.message}`);
    if (!data) return slug;
    n++;
    slug = `${base}-${n}`;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") || "";

  // Cliente "as caller": mismo anon key, pero con el JWT de quien llamó --
  // getUser() valida el token y devuelve al usuario real de Google, sin
  // necesitar la service_role key para esta parte.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Sesión inválida -- vuelve a iniciar sesión." }, 401);
  }
  const caller = userData.user;
  const callerEmail = (caller.email || "").trim().toLowerCase();
  if (!callerEmail) {
    return json({ error: "Tu cuenta de Google no tiene un correo válido." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const body = await req.json();
    const businessName = String(body.businessName || "").trim();
    const branchName = String(body.branchName || businessName).trim();
    const contactPhone = body.contactPhone ? String(body.contactPhone).trim() : null;
    const planId = String(body.planId || "");

    if (!businessName) return json({ error: "El nombre del negocio es obligatorio." }, 400);
    if (!branchName) return json({ error: "El nombre de la sucursal inicial es obligatorio." }, 400);
    if (!isValidPlanId(planId)) return json({ error: "Plan inválido." }, 400);
    const plan = PLAN_CATALOG[planId];

    // Un negocio por cuenta de Google -- si ya dio de alta uno, no se
    // duplica. El operador puede agregar sucursales extra desde el panel
    // SuperAdmin después si el mismo dueño abre otra sucursal.
    const { data: existingUser, error: existingErr } = await admin
      .from("users").select("id").eq("auth_user_id", caller.id).maybeSingle();
    if (existingErr) throw new Error(`No se pudo verificar cuentas existentes: ${existingErr.message}`);
    if (existingUser) {
      return json({ error: "Ya diste de alta un negocio con esta cuenta de Google." }, 409);
    }

    const { data: existingTenant, error: tenantExistErr } = await admin
      .from("tenants").select("id").eq("name", businessName).maybeSingle();
    if (tenantExistErr) throw new Error(`No se pudo verificar negocios existentes: ${tenantExistErr.message}`);
    if (existingTenant) {
      return json({ error: `Ya existe un negocio llamado "${businessName}".` }, 409);
    }

    // Pago simulado (ver comentario de arriba) => el primer ciclo ya queda
    // "cobrado" desde hoy. Los 3 planes son renta mensual (sin opción de
    // licencia/pago único por ahora, ver conversación con el dueño del
    // proyecto), así que siempre hay un próximo corte que agendar.
    const nextDueDate = (() => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCMonth(d.getUTCMonth() + 1);
      return d.toISOString().slice(0, 10);
    })();

    // 1. Tenant
    const slug = await uniqueSlug(admin, businessName);
    const { data: tenant, error: tenantErr } = await admin
      .from("tenants")
      .insert({
        name: businessName,
        slug,
        active: true,
        contact_email: callerEmail,
        contact_phone: contactPhone,
        price: plan.price,
        billing_type: plan.billingType,
        billing_status: "active",
        next_due_date: nextDueDate,
        plan_id: planId,
      })
      .select()
      .single();
    if (tenantErr) throw new Error(`No se pudo crear el negocio: ${tenantErr.message}`);

    // 2. Sucursal inicial
    const { data: branch, error: branchErr } = await admin
      .from("branches").insert({ name: branchName, tenant_id: tenant.id }).select().single();
    if (branchErr) throw new Error(`Negocio creado (id ${tenant.id}), pero falló la sucursal: ${branchErr.message}`);

    // 3. Secreto de KDS
    const kdsSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const { error: secretErr } = await admin
      .from("branch_kds_secrets").insert({ branch_id: branch.id, secret: kdsSecret });
    if (secretErr) throw new Error(`Negocio y sucursal creados, pero falló el secreto de KDS: ${secretErr.message}`);

    // 4. Fila en public.users -- SIN admin.auth.admin.createUser(): el
    // auth.users ya existe (el login con Google que trajo hasta aquí), solo
    // se enlaza (auth_user_id) y se genera una contraseña propia para el
    // login del sistema de escritorio (no usa Google).
    const password = makePassword();
    const { salt, hash } = makeCredentials(password);
    const username = callerEmail.split("@")[0].replace(/[^a-z0-9._-]/gi, "") || `owner${branch.id}`;
    const { data: userRow, error: userInsertErr } = await admin.from("users").insert({
      username,
      name: "Dueño",
      role: "admin",
      password_hash: hash,
      password_salt: salt,
      branch_id: branch.id,
      active: true,
      email: callerEmail,
      auth_user_id: caller.id,
    }).select().single();
    if (userInsertErr) throw new Error(`Negocio y sucursal creados, pero falló la cuenta de la app: ${userInsertErr.message}`);

    // 5. Ajustes iniciales
    await admin.from("settings").insert([
      { key: "business_name", value: businessName, branch_id: branch.id },
      { key: "theme_auto", value: "false", branch_id: branch.id },
    ]);

    return json({
      tenant,
      branch,
      kdsSecret,
      adminLogin: { username: userRow.username, password },
    });
  } catch (err) {
    console.error("Error en self-serve-onboard:", err);
    return json({ error: err instanceof Error ? err.message : "Error interno" }, 500);
  }
});
