import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

// Protege /inicio (el chatbot): si el rol del usuario no tiene la capacidad
// "chat", se le redirige a /archivos. El backend además corta POST /api/chat,
// así que esto es solo UX (no se puede saltar el control real por la URL).
export const chatGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.puedeChat() ? true : router.createUrlTree(['/archivos']);
};
