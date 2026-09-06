// Datos de cobro por transferencia manual (sin procesador conectado
// todavía, ver comentario en self-serve-onboard/index.ts) -- fuente única
// para que self-serve-onboard y onboard-tenant devuelvan siempre la misma
// info al frontend, en vez de que cada uno la escriba por su cuenta.
// Cambiar de banco/cuenta se hace aquí, una sola vez.
export const PAYMENT_INFO = {
  beneficiary: "URIEL VARGAS / KATSAM",
  bank: "BANAMEX",
  account: "5256784268250791",
};

// Referencia única por cliente para identificar su pago en el estado de
// cuenta (concepto de la transferencia) -- formato WH-{ABREVIATURA}-{id},
// ej. "WH-TACO-0001". Se arma con el id de tenants (serial, ya único) para
// no depender de un contador aparte -- cero riesgo de colisión.
export function buildPaymentReference(businessName: string, tenantId: number | string): string {
  const abbr = businessName
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase()
    .slice(0, 4) || "CLI";
  const seq = String(tenantId).padStart(4, "0");
  return `WH-${abbr}-${seq}`;
}
