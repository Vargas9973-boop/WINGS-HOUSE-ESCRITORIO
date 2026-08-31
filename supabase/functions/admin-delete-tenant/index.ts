// Elimina un tenant por completo desde el panel SuperAdmin
// (wing-house-web/src/pages/admin/DeleteTenantModal.jsx) -- el RPC
// admin_delete_tenant (SQL, wing-house-web/supabase/migrations/
// 20260830060000_admin_delete_tenant.sql) ya borra TODO lo de public.*
// (branches, sales, products, users, etc.), pero ese RPC no puede tocar
// auth.users -- eso requiere la Admin API de GoTrue (supabase.auth.admin.*),
// que solo funciona con la service_role key, nunca con el JWT del caller.
// Sin esta Edge Function, "eliminar" dejaba las cuentas de Supabase Auth de
// los empleados de ese tenant huérfanas (con contraseña real y todo, aunque
// ya no puedan entrar por login/index.ts al no existir su fila en
// public.users).
//
// Mismo criterio que admin-reset-password/index.ts en todo:
//   - Autorización: reenvía el JWT del caller a is_superadmin() vía un
//     cliente anon normal -- single fuente de verdad, no se duplica el
//     email hardcodeado aquí.
//   - El RPC en sí se llama con el cliente del CALLER (no con el de
//     service_role) para que is_superadmin() lo vuelva a validar server-side
//     con auth.jwt() real -- defensa en profundidad, no confía en que el
//     check de arriba ya baste.
//   - Los auth_user_id se leen ANTES de correr el RPC (una vez borrado
//     public.users ya no hay de dónde sacarlos) usando el cliente admin
//     (bypassa RLS) -- necesario porque el caller (superadmin) no tiene
//     fila propia en public.users y no puede leer la de otros tenants por
//     RLS normal.
//   - Borrar cada auth.users es best-effort DESPUÉS de que el RPC ya tuvo
//     éxito: si algo falla aquí, los datos de negocio (lo que de verdad
//     importa) ya se borraron; se reporta authUsersFailed para que el
//     panel pueda avisar, no para bloquear el borrado.
import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") || "";

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
    const tenantId = Number(body.tenantId);
    const confirmName = String(body.confirmName || "");
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      return json({ error: "tenantId inválido." }, 400);
    }
    if (!confirmName.trim()) {
      return json({ error: "confirmName obligatorio." }, 400);
    }

    // auth_user_id de todos los empleados de este tenant, ANTES de borrar
    // public.users (donde vive esa referencia) -- con el cliente admin
    // porque el superadmin no tiene fila propia en users y no puede leerla
    // por RLS normal. Dos queries simples (branches -> users por branch_id)
    // en vez de un embed de PostgREST -- menos superficie para un error de
    // detección de relación que además fallaría en silencio (data vacío,
    // sin lanzar error) y dejaría auth.users huérfano sin que nadie se dé
    // cuenta.
    const { data: branchRows, error: branchesErr } = await admin
      .from("branches")
      .select("id")
      .eq("tenant_id", tenantId);
    if (branchesErr) throw new Error(`No se pudieron listar las sucursales del tenant: ${branchesErr.message}`);
    const branchIds = (branchRows || []).map((b: any) => b.id);

    let authUserIds: string[] = [];
    if (branchIds.length > 0) {
      const { data: userRows, error: usersErr } = await admin
        .from("users")
        .select("auth_user_id")
        .in("branch_id", branchIds)
        .not("auth_user_id", "is", null);
      if (usersErr) throw new Error(`No se pudieron listar los usuarios del tenant: ${usersErr.message}`);
      authUserIds = (userRows || []).map((r: any) => r.auth_user_id).filter(Boolean);
    }

    // El RPC real (borra todo public.*) -- con el cliente del CALLER, no el
    // de service_role, para que is_superadmin() lo revalide con su JWT real.
    const { data: rpcData, error: rpcErr } = await callerClient.rpc("admin_delete_tenant", {
      p_tenant_id: tenantId,
      p_confirm_name: confirmName,
    });
    if (rpcErr) throw new Error(rpcErr.message);
    if (!rpcData || rpcData.ok !== true) {
      return json({ error: "El RPC no confirmó el borrado." }, 500);
    }

    let authUsersDeleted = 0;
    const authUsersFailed: string[] = [];
    for (const uid of authUserIds) {
      const { error: delErr } = await admin.auth.admin.deleteUser(uid);
      if (delErr) {
        console.error(`No se pudo borrar auth.users ${uid} (no bloqueante):`, delErr.message);
        authUsersFailed.push(uid);
      } else {
        authUsersDeleted += 1;
      }
    }

    return json({
      ok: true,
      tenant_name: rpcData.tenant_name,
      counts: rpcData.counts,
      authUsersDeleted,
      authUsersFailed,
    });
  } catch (err) {
    console.error("Error en admin-delete-tenant:", err);
    return json({ error: err instanceof Error ? err.message : "Error interno" }, 500);
  }
});
