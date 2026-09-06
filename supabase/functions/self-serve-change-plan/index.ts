// "Cambiar plan" en panel_saas (Onboarding.jsx, vista de cuenta ya
// registrada) -- sube o baja el plan de renta del propio negocio del
// llamador, sin pasar por el SuperAdmin. A diferencia de self-serve-onboard,
// esto SÍ actualiza tenants directo (no crea nada) y no depende de validar
// un pago primero: el cambio de plan/precio aplica de inmediato, el cobro
// (transferencia) sigue el mismo ciclo mensual que ya tenía el tenant
// (billing_status/next_due_date no se tocan aquí).
//
// El plan (precio/módulos) se resuelve del catálogo compartido
// _shared/plans.ts, igual que self-serve-onboard -- nunca del body, por la
// misma razón (evitar que el cliente mande su propio precio).
import { createClient } from "npm:@supabase/supabase-js@2";
import { isValidPlanId, maxUsersForPlan, PLAN_CATALOG } from "../_shared/plans.ts";
import { buildPaymentReference, PAYMENT_INFO } from "../_shared/billing.ts";

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

  const { data: userData, error: userErr } = await callerClient.auth.getUser();
  if (userErr || !userData?.user) {
    return json({ error: "Sesión inválida -- vuelve a iniciar sesión." }, 401);
  }
  const caller = userData.user;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const body = await req.json();
    const planId = String(body.planId || "");
    if (!isValidPlanId(planId)) return json({ error: "Plan inválido." }, 400);
    const plan = PLAN_CATALOG[planId];

    const { data: userRow, error: userRowErr } = await admin
      .from("users").select("branch_id").eq("auth_user_id", caller.id).maybeSingle();
    if (userRowErr) throw new Error(`No se pudo verificar la cuenta: ${userRowErr.message}`);
    if (!userRow) return json({ error: "Todavía no das de alta un negocio con esta cuenta." }, 404);

    const { data: branch, error: branchErr } = await admin
      .from("branches").select("tenant_id").eq("id", userRow.branch_id).maybeSingle();
    if (branchErr) throw new Error(`No se pudo resolver el negocio: ${branchErr.message}`);
    if (!branch) return json({ error: "Todavía no das de alta un negocio con esta cuenta." }, 404);

    // Freno a una bajada de plan que dejaría al negocio con más cuentas
    // activas de las que su nuevo plan permite -- mismo límite/criterio que
    // el alta de usuarios en el desktop (ver main.js, requirePermission
    // users:create). Sin este freno, un downgrade silencioso dejaría
    // cuentas "de más" operando hasta que alguien intente crear una nueva.
    const maxUsers = maxUsersForPlan(planId);
    if (maxUsers != null) {
      const { data: branchIds, error: branchIdsErr } = await admin
        .from("branches").select("id").eq("tenant_id", branch.tenant_id);
      if (branchIdsErr) throw new Error(`No se pudo verificar tus sucursales: ${branchIdsErr.message}`);
      const ids = (branchIds || []).map((b) => b.id);
      const { count, error: countErr } = await admin
        .from("users").select("id", { count: "exact", head: true })
        .in("branch_id", ids).eq("active", true);
      if (countErr) throw new Error(`No se pudo verificar tus usuarios activos: ${countErr.message}`);
      if ((count || 0) > maxUsers) {
        return json({
          error: `El plan ${plan.label} permite hasta ${maxUsers} usuarios y tu negocio tiene ${count} activos. Desactiva algunos antes de bajar de plan.`,
        }, 409);
      }
    }

    const { data: tenant, error: updateErr } = await admin
      .from("tenants")
      .update({ plan_id: planId, price: plan.price, billing_type: plan.billingType })
      .eq("id", branch.tenant_id)
      .select()
      .single();
    if (updateErr) throw new Error(`No se pudo actualizar el plan: ${updateErr.message}`);

    const paymentReference = tenant.payment_reference || buildPaymentReference(tenant.name, tenant.id);

    return json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        planId: tenant.plan_id,
        planLabel: plan.label,
        billingStatus: tenant.billing_status,
        nextDueDate: tenant.next_due_date,
        payment: {
          businessName: tenant.name,
          plan: plan.label,
          amount: tenant.price,
          reference: paymentReference,
          ...PAYMENT_INFO,
        },
      },
    });
  } catch (err) {
    console.error("Error en self-serve-change-plan:", err);
    return json({ error: err instanceof Error ? err.message : "Error interno" }, 500);
  }
});
