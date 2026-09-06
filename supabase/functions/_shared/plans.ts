// Catálogo único de planes de renta -- fuente de verdad para
// self-serve-onboard, onboard-tenant y login (que calcula qué módulos ve
// cada tenant). Cambiar un precio o qué módulos trae un plan se hace aquí,
// una sola vez -- nunca dupliques estos valores en otro archivo.
//
// PRECIOS/MÓDULOS SON PROVISIONALES (ver conversación con el dueño del
// proyecto, 2026-09-05) -- pendiente de confirmar montos finales antes de
// anunciarlos a clientes nuevos.
export type PlanId = "esencial" | "operacion_completa" | "multisucursal";

export const PLAN_IDS: PlanId[] = ["esencial", "operacion_completa", "multisucursal"];

// maxUsers: null = sin límite. Cuenta TODAS las filas en public.users de la
// sucursal (incluye al dueño/admin creado en el alta) -- no es "3 empleados
// además del dueño", es "3 cuentas en total", más simple de explicar y de
// hacer cumplir (ver requirePermission/users:create en main.js).
export const PLAN_CATALOG: Record<PlanId, { label: string; price: number; billingType: "monthly"; description: string; maxUsers: number | null }> = {
  esencial: {
    label: "Esencial",
    price: 549,
    billingType: "monthly",
    description: "1 sucursal, hasta 3 usuarios (ej. gerente, mesero, cajero). Ventas, comandas, catálogo, corte de caja, inventario, historial y cuentas.",
    maxUsers: 3,
  },
  operacion_completa: {
    label: "Operación Completa",
    price: 899,
    billingType: "monthly",
    description: "Hasta 6 usuarios. Agrega cocina (KDS), costos y reportes avanzados.",
    maxUsers: 6,
  },
  multisucursal: {
    label: "Multisucursal",
    price: 1499,
    billingType: "monthly",
    description: "Usuarios ilimitados y acceso a todos los módulos (nómina, asistencia). Sigue siendo 1 sucursal -- sucursales adicionales se cotizan aparte.",
    maxUsers: null,
  },
};

// Claves = mismas que public.role_permissions.module (ver
// 20260822030000_roles_permissions.sql) y guardPermission()/hasPermission()
// en el desktop (common.js/main.js). No se puede sub-gatear una función
// dentro de un módulo (p.ej. combos dentro de catálogo) sin trabajo aparte
// -- la granularidad de gating hoy es por módulo completo.
const ESENCIAL_MODULES = ["ventas", "comandas", "catalogo", "corte", "inventario", "historial", "ajustes", "cuentas"];
const OPERACION_COMPLETA_MODULES = [...ESENCIAL_MODULES, "kds", "costos", "reportes"];
const MULTISUCURSAL_MODULES = [...OPERACION_COMPLETA_MODULES, "asistencia", "nomina"];

export const PLAN_MODULES: Record<PlanId, string[]> = {
  esencial: ESENCIAL_MODULES,
  operacion_completa: OPERACION_COMPLETA_MODULES,
  multisucursal: MULTISUCURSAL_MODULES,
};

export function isValidPlanId(value: unknown): value is PlanId {
  return typeof value === "string" && (PLAN_IDS as string[]).includes(value);
}

// Fail-open a propósito: un plan_id nulo/desconocido (fila vieja, dato
// corrupto, tenant creado antes de que existiera esta columna) da acceso
// completo en vez de dejar a alguien fuera de un módulo que ya pagó -- ver
// Tenant 1 ($1500/mes, todos los módulos, vendido antes de este sistema).
export function modulesForPlan(planId: string | null | undefined): string[] {
  if (isValidPlanId(planId)) return PLAN_MODULES[planId];
  return MULTISUCURSAL_MODULES;
}

// Mismo criterio fail-open que modulesForPlan(): plan_id nulo/desconocido
// -> null (sin límite), nunca bloquea por un dato faltante o viejo.
export function maxUsersForPlan(planId: string | null | undefined): number | null {
  if (isValidPlanId(planId)) return PLAN_CATALOG[planId].maxUsers;
  return null;
}
