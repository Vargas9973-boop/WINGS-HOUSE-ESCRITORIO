// Resetea la contraseña de un usuario (típicamente el admin/dueño de un
// tenant) desde el panel SuperAdmin (wing-house-web/src/pages/admin) --
// soporte real: el dueño olvida su contraseña y no hay forma hoy de
// dársela de nuevo sin ir a mano a la base.
//
// Mismo criterio que onboard-tenant/index.ts en todo:
//   - Autorización: reenvía el JWT del caller a is_superadmin() vía un
//     cliente anon normal -- single source of verdad de quién es
//     SuperAdmin, no se duplica el email aquí.
//   - Contraseña: mismo scrypt+sal que hashPassword()/makeCredentials() en
//     db.js y en login/index.ts. La Edge Function `login` valida contra
//     public.users.password_hash/password_salt, NO contra auth.users --
//     ESE es el que de verdad importa para poder entrar. auth.users.password
//     también se actualiza aquí (best-effort) solo por consistencia, no
//     porque el login lo use.
//   - service_role key nunca sale de este proceso ni llega al navegador.
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

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function makeCredentials(password: string): { salt: string; hash: string } {
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { salt, hash: hashPassword(password, salt) };
}

// Sin 0/O/1/l/I -- se lee y se dicta por teléfono/WhatsApp sin ambigüedad.
// 12 caracteres de un alfabeto de 54 símbolos: ~68 bits de entropía, de
// sobra para una contraseña temporal que el dueño va a cambiar después.
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
function generateTempPassword(length = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes).map((b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join("");
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
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return json({ error: "userId inválido." }, 400);
    }

    const { data: userRow, error: userErr } = await admin
      .from("users")
      .select("id, username, email, auth_user_id")
      .eq("id", userId)
      .maybeSingle();
    if (userErr) throw new Error(`No se pudo buscar el usuario: ${userErr.message}`);
    if (!userRow) return json({ error: `Usuario ${userId} no existe.` }, 404);

    const newPassword = generateTempPassword();
    const { salt, hash } = makeCredentials(newPassword);

    const { error: updateErr } = await admin
      .from("users")
      .update({ password_hash: hash, password_salt: salt })
      .eq("id", userId);
    if (updateErr) throw new Error(`No se pudo actualizar la contraseña: ${updateErr.message}`);

    // Best-effort: mantiene sincronizado auth.users por si algo más lo usa
    // (ej. un futuro flujo de "olvidé mi contraseña" vía Supabase Auth). Si
    // falla, la contraseña real de la app (arriba) ya quedó actualizada.
    let authSynced = true;
    if (userRow.auth_user_id) {
      const { error: authUpdateErr } = await admin.auth.admin.updateUserById(userRow.auth_user_id, {
        password: newPassword,
      });
      if (authUpdateErr) {
        authSynced = false;
        console.error("No se pudo sincronizar auth.users (no bloqueante):", authUpdateErr.message);
      }
    } else {
      authSynced = false;
    }

    return json({
      username: userRow.username,
      email: userRow.email,
      newPassword,
      authSynced,
    });
  } catch (err) {
    console.error("Error en admin-reset-password:", err);
    return json({ error: err instanceof Error ? err.message : "Error interno" }, 500);
  }
});
