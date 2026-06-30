import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

// Solo el superadmin de la plataforma (panel de empresas). Si no, a /inicio.
export const superadminGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.esSuperadmin() ? true : router.createUrlTree(['/inicio']);
};
