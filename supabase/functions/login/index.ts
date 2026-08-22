// Puente de sesión real (punto 2 del audit SaaS): el proyecto usa Signing
// Keys asimétricas (ES256) -- solo el servicio de Auth de Supabase tiene la
// private key, así que ningún RPC de Postgres puede firmar un JWT válido.
// Esta función NO firma nada: verifica el password contra public.users tal
// cual (mismo scrypt+sal de siempre, cero migración de contraseñas), y si
// es válido le pide a la Admin API de Auth (service_role, inyectado
// automáticamente por el runtime de Edge Functions) que emita una sesión
// real -- generateLink + verifyOtp, sin mandar ningún correo de verdad, el
// token se consume al toque. Quien firma sigue siendo GoTrue con la clave
// real.
//
// Etapa actual (ver conversación): verificada end-to-end (2026-08-22) --
// con la sesión real, auth.uid()/auth.role() resuelven correctamente vía
// PostgREST, y un JWT con firma alterada es rechazado con 401 antes de
// llegar a Postgres. Las políticas de RLS siguen en USING (true) todavía
// -- no usan auth.uid()/auth.jwt() -- y db.js / wing-house-web/Login.jsx
// TODAVÍA NO llaman esta función. Eso es el siguiente paso.
import { createClient } from "npm:@supabase/supabase-js@2";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";

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

// Idéntico a hashPassword() en db.js: crypto.scryptSync(password, salt, 64)
// -- salt es un string (hex de 16 bytes random), usado TAL CUAL como string,
// no hex-decodeado, exactamente como lo interpreta Node cuando salt es un
// string. node:crypto en Deno implementa el mismo algoritmo/firma.
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function hashesMatch(hexA: string, hexB: string): boolean {
  const a = Buffer.from(hexA, "hex");
  const b = Buffer.from(hexB, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { username, password } = await req.json();
    if (!username || !password) {
      return json({ error: "username y password son requeridos" }, 400);
    }
    const cleanUsername = String(username).trim().toLowerCase();

    const { data: user, error: userErr } = await admin
      .from("users")
      .select("*")
      .eq("username", cleanUsername)
      .eq("active", true)
      .maybeSingle();

    if (userErr) {
      console.error("Error consultando users:", userErr.message);
      return json({ error: "Error al consultar el usuario" }, 500);
    }
    if (!user || !user.password_hash || !user.password_salt) {
      return json({ error: "Usuario o contraseña incorrectos." }, 401);
    }

    const computed = hashPassword(String(password), user.password_salt);
    if (!hashesMatch(computed, user.password_hash)) {
      return json({ error: "Usuario o contraseña incorrectos." }, 401);
    }

    // Email estable para el puente a auth.users. Son cuentas internas de
    // staff -- nunca se manda un correo real, el link se consume al toque
    // server-side. Si el usuario no tenía email (creado antes de esta
    // función, o vía createUser() que hoy no lo pide), se sintetiza uno
    // determinístico y se persiste para que quede estable entre logins.
    let email = user.email;
    if (!email) {
      email = `user-${user.id}@users.internal.wingshouse`;
      const { error: emailErr } = await admin
        .from("users")
        .update({ email })
        .eq("id", user.id);
      if (emailErr) {
        console.error("No se pudo persistir el email sintético:", emailErr.message);
      }
    }

    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error("generateLink falló:", linkErr?.message);
      return json({ error: "No se pudo iniciar sesión" }, 500);
    }

    const anonClient = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: sessionData, error: verifyErr } = await anonClient.auth.verifyOtp({
      type: "magiclink",
      token_hash: linkData.properties.hashed_token,
    });
    if (verifyErr || !sessionData.session) {
      console.error("verifyOtp falló:", verifyErr?.message);
      return json({ error: "No se pudo iniciar sesión" }, 500);
    }

    let permissions: unknown[] = [];
    try {
      const { data: permData, error: permErr } = await admin.rpc("get_user_permissions", {
        p_user_id: user.id,
      });
      if (!permErr) permissions = permData || [];
    } catch (_) {
      // login nunca debe fallar por esto -- mismo criterio que db.js.
    }

    return json({
      session: {
        access_token: sessionData.session.access_token,
        refresh_token: sessionData.session.refresh_token,
        expires_at: sessionData.session.expires_at,
      },
      profile: {
        id: user.id,
        username: user.username,
        displayName: user.name,
        role: user.role,
        roleId: user.role_id || null,
        branchId: user.branch_id,
        permissions,
      },
    });
  } catch (err) {
    console.error("Error inesperado en login:", err);
    return json({ error: "Error interno" }, 500);
  }
});
