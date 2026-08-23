// Onboarding de negocio nuevo (tenant) desde el panel SuperAdmin
// (wing-house-web/src/pages/admin/TenantFormModal.jsx) -- versión Edge
// Function de scripts/onboard-tenant.js (CLI), para que el operador ya no
// tenga que abrir una terminal con la service_role key cada vez que vende
// una licencia nueva. Mismos pasos, mismo orden, mismo criterio de
// contraseñas (scrypt+sal, idéntico a hashPassword()/makeCredentials() en
// db.js y en supabase/functions/login/index.ts).
//
// Autorización: solo el SuperAdmin puede llamar esto -- se verifica
// reenviando el JWT del caller (que supabase.functions.invoke ya manda en
// el header Authorization) a is_superadmin() vía un cliente anon normal,
// en vez de duplicar aquí el email hardcodeado que compara esa función
// (single source of truth, ver 20260824000000_tenants_billing.sql --
// aplicada en producción, capturada de nuevo en
// 20260823190000_superadmin_onboarding_catchup.sql). La service_role key
// (que SÍ hace falta para crear el usuario de Auth y saltarse RLS al armar
// tenant/branch/users) nunca sale de este proceso ni llega al navegador.
import { createClient } from "npm:@supabase/supabase-js@2";
import { scryptSync } from "node:crypto";

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

// Idéntico a hashPassword()/makeCredentials() en db.js y en
// supabase/functions/login/index.ts.
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function makeCredentials(password: string): { salt: string; hash: string } {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { salt, hash: hashPassword(password, salt) };
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
  // así auth.jwt() dentro de is_superadmin() resuelve al usuario real que
  // está pidiendo esto, no a nadie con la anon key sola.
  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: isSuperadmin, error: authCheckErr } = await callerClient.rpc("is_superadmin");
  if (authCheckErr || isSuperadmin !== true) {
    return json({ error: "No autorizado." }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const body = await req.json();
    const businessName = String(body.name || "").trim();
    const branchName = String(body.branchName || businessName).trim();
    const adminEmail = String(body.adminEmail || "").trim().toLowerCase();
    const adminPassword = String(body.adminPassword || "");
    const contactEmail = body.contactEmail ? String(body.contactEmail).trim() : null;
    const contactPhone = body.contactPhone ? String(body.contactPhone).trim() : null;
    const price = body.price != null && body.price !== "" ? Number(body.price) : 0;
    const billingType = body.billingType || "monthly";
    const nextDueDate = body.nextDueDate || null;

    if (!businessName) return json({ error: "El nombre del negocio es obligatorio." }, 400);
    if (!branchName) return json({ error: "El nombre de la sucursal inicial es obligatorio." }, 400);
    if (!adminEmail) return json({ error: "El correo del administrador es obligatorio." }, 400);
    if (adminPassword.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres." }, 400);

    const { data: existingTenant, error: existErr } = await admin
      .from("tenants").select("id").eq("name", businessName).maybeSingle();
    if (existErr) throw new Error(`No se pudo verificar clientes existentes: ${existErr.message}`);
    if (existingTenant) {
      return json({ error: `Ya existe un cliente llamado "${businessName}".` }, 409);
    }

    // 1. Tenant
    const slug = await uniqueSlug(admin, businessName);
    const { data: tenant, error: tenantErr } = await admin
      .from("tenants")
      .insert({
        name: businessName,
        slug,
        active: true,
        contact_email: contactEmail,
        contact_phone: contactPhone,
        price,
        billing_type: billingType,
        next_due_date: nextDueDate,
      })
      .select()
      .single();
    if (tenantErr) throw new Error(`No se pudo crear el cliente: ${tenantErr.message}`);

    // 2. Sucursal inicial
    const { data: branch, error: branchErr } = await admin
      .from("branches").insert({ name: branchName, tenant_id: tenant.id }).select().single();
    if (branchErr) throw new Error(`Cliente creado (id ${tenant.id}), pero falló la sucursal: ${branchErr.message}`);

    // 3. Secreto de KDS
    const kdsSecret = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const { error: secretErr } = await admin
      .from("branch_kds_secrets").insert({ branch_id: branch.id, secret: kdsSecret });
    if (secretErr) throw new Error(`Cliente y sucursal creados, pero falló el secreto de KDS: ${secretErr.message}`);

    // 4. Usuario de Supabase Auth (vínculo para auth_user_id / current_branch_id())
    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email: adminEmail,
      password: adminPassword,
      email_confirm: true,
    });
    if (authErr) throw new Error(`Cliente y sucursal creados, pero falló el usuario de Auth: ${authErr.message}`);

    // 5. Fila real en public.users -- la Edge Function `login` valida la
    // contraseña contra esto, no contra auth.users.
    const { salt, hash } = makeCredentials(adminPassword);
    const username = adminEmail.split("@")[0].replace(/[^a-z0-9._-]/gi, "") || `owner${branch.id}`;
    const { data: userRow, error: userErr } = await admin.from("users").insert({
      username,
      name: "Dueño",
      role: "admin",
      password_hash: hash,
      password_salt: salt,
      branch_id: branch.id,
      active: true,
      email: adminEmail,
      auth_user_id: authUser.user.id,
    }).select().single();
    if (userErr) throw new Error(`Cliente, sucursal y usuario de Auth creados, pero falló la cuenta en la app: ${userErr.message}`);

    // 6. Ajustes iniciales
    await admin.from("settings").insert([
      { key: "business_name", value: businessName, branch_id: branch.id },
      { key: "theme_auto", value: "false", branch_id: branch.id },
    ]);

    return json({
      tenant,
      branch,
      kdsSecret,
      adminLogin: { username: userRow.username, email: adminEmail },
    });
  } catch (err) {
    console.error("Error en onboard-tenant:", err);
    return json({ error: err instanceof Error ? err.message : "Error interno" }, 500);
  }
});
