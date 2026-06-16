// Este archivo extiende el tipo Request de Express.
// Sin esto, TypeScript no sabría que req.usuario existe,
// y daría error en todos los controladores que lo usen.

declare global {
  namespace Express {
    interface Request {
      usuario?: {
        id: string;    // UUID del usuario en la BD
        email: string;
        rol: string;   // "user" | "admin"
      };
    }
  }
}

// Necesario para que TypeScript trate esto como un módulo
export {};
