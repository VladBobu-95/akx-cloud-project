import { Injectable } from '@angular/core';
import { HttpEvent, HttpHandler, HttpInterceptor, HttpRequest } from '@angular/common/http';
import { from, Observable, switchMap } from 'rxjs';
import { AuthService } from './auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private auth: AuthService) {}

  intercept(req: HttpRequest<unknown>, next: HttpHandler): Observable<HttpEvent<unknown>> {
    if (req.url.includes('/api/auth/login') || req.url.includes('/connected/gate')) {
      return next.handle(req);
    }
    return from(this.auth.token()).pipe(
      switchMap((token) => {
        if (!token) return next.handle(req);
        return next.handle(req.clone({ setHeaders: { Authorization: `Bearer ${token}` } }));
      }),
    );
  }
}
