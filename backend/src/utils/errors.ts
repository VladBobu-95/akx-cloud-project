// Error personalizado de la aplicación.
// Permite lanzar errores con un código HTTP específico desde cualquier servicio.
// El manejo centralizado de errores vive en middlewares/errorHandler.middleware.ts.
export class AppError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
    this.name = "AppError";
  }
}
