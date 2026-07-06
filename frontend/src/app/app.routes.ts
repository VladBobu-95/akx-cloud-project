import { Routes } from '@angular/router';
import { authGuard } from './core/auth.guard';
import { superadminGuard } from './core/superadmin.guard';
import { adminGuard } from './core/admin.guard';
import { chatGuard } from './core/chat.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login').then((m) => m.Login),
  },
  {
    path: '',
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    canActivate: [authGuard],
    children: [
      {
        path: 'inicio',
        loadComponent: () =>
          import('./pages/inicio/inicio').then((m) => m.InicioPage),
        canActivate: [chatGuard],
      },
      {
        path: 'archivos',
        loadComponent: () =>
          import('./pages/archivos/archivos').then((m) => m.ArchivosPage),
      },
      {
        path: 'facturas',
        loadComponent: () =>
          import('./pages/facturas/facturas').then((m) => m.FacturasPage),
      },
      {
        path: 'papelera',
        loadComponent: () =>
          import('./pages/papelera/papelera').then((m) => m.PapeleraPage),
      },
      {
        path: 'perfil',
        loadComponent: () => import('./pages/perfil/perfil').then((m) => m.PerfilPage),
      },
      {
        path: 'plataforma',
        loadComponent: () =>
          import('./pages/plataforma/plataforma').then((m) => m.PlataformaPage),
        canActivate: [superadminGuard],
      },
      {
        path: 'equipo',
        loadComponent: () => import('./pages/equipo/equipo').then((m) => m.EquipoPage),
        canActivate: [adminGuard],
      },
      { path: '', redirectTo: 'inicio', pathMatch: 'full' },
    ],
  },
  { path: '**', redirectTo: '' },
];
