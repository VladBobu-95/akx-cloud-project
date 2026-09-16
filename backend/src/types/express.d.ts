// Este archivo extiende el tipo Request de Express.
// Sin esto, TypeScript no sabría que req.usuario existe,
// y daría error en todos los controladores que lo usen.

declare global {
  namespace Express {
    interface Request {
      usuario?: {
        id: string;    // UUID del usuario en la BD
        email: string;
        rol: string;   // "superadmin" | "admin" | "miembro"
        empresaId: string | null; // tenant; null solo para superadmin
      };
      // Solo POST /api/n8n/facturas: si el hash ya existe, sube copia con
      // " copia" en el nombre en vez de devolver duplicado:true.
      permitirCopiaN8n?: boolean;
    }
  }
}

// Necesario para que TypeScript trate esto como un módulo
export {};
