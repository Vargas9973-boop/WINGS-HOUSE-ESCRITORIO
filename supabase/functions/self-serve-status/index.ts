// Le dice a panel_saas (Onboarding.jsx) si la cuenta de Google que acaba de
// iniciar sesión ya dio de alta un negocio -- hermano de self-serve-onboard,
// mismo criterio de autorización (cualquier sesión válida, sin
// is_superadmin()) pero de solo lectura. Antes de esto, self-serve-onboard
// era la única forma de saberlo: el frontend arrancaba siempre el wizard de
// alta y recién al final (Procesar pago) el servidor contestaba 409 "ya
// diste de alta un negocio". Ahora el frontend puede preguntar primero y, si
// ya existe, saltarse el wizard directo a mostrar los datos de transferencia
// + "Cambiar plan" (ver self-serve-change-plan).
import { createClient } from "npm:@supabase/supabase-js@2";
import { isValidPlanId, PLAN_CATALOG } from "../_shared/plans.ts";
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
    const { data: userRow, error: userRowErr } = await admin
      .from("users").select("branch_id").eq("auth_user_id", caller.id).maybeSingle();
    if (userRowErr) throw new Error(`No se pudo verificar la cuenta: ${userRowErr.message}`);
    if (!userRow) return json({ tenant: null });

    const { data: branchRow, error: branchErr } = await admin
      .from("branches")
      .select("tenant:tenants(id, name, plan_id, price, billing_type, billing_status, next_due_date, payment_reference)")
      .eq("id", userRow.branch_id)
      .maybeSingle();
    if (branchErr) throw new Error(`No se pudo resolver el negocio: ${branchErr.message}`);

    const tenantRaw = branchRow?.tenant as Record<string, unknown> | Record<string, unknown>[] | null;
    const tenant = Array.isArray(tenantRaw) ? tenantRaw[0] : tenantRaw;
    if (!tenant) return json({ tenant: null });

    const planId = tenant.plan_id as string | null;
    const plan = isValidPlanId(planId) ? PLAN_CATALOG[planId] : null;
    // Mismos campos que self-serve-onboard::payment -- reference ya quedó
    // guardada en el alta, pero se recalcula con la misma fórmula si por lo
    // que sea faltara (fila vieja/backfill), nunca null en la respuesta.
    const paymentReference = (tenant.payment_reference as string | null) || buildPaymentReference(tenant.name as string, tenant.id as number);

    return json({
      tenant: {
        id: tenant.id,
        name: tenant.name,
        planId,
        planLabel: plan?.label ?? planId,
        billingStatus: tenant.billing_status,
        nextDueDate: tenant.next_due_date,
        payment: {
          businessName: tenant.name,
          plan: plan?.label ?? planId,
          amount: tenant.price,
          reference: paymentReference,
          ...PAYMENT_INFO,
        },
      },
    });
  } catch (err) {
    console.error("Error en self-serve-status:", err);
    return json({ error: err instanceof Error ? err.message : "Error interno" }, 500);
  }
});
