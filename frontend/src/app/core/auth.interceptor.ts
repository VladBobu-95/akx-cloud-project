import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

// Añade el Bearer token a cada peticion. Si el backend responde 401 con un token
// presente (sesion caducada), cerramos sesion y volvemos al login.
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const token = auth.token();

  const peticion = token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(peticion).pipe(
    catchError((err) => {
      if (err.status === 401 && token) {
        auth.logout();
      }
      return throwError(() => err);
    }),
  );
};
