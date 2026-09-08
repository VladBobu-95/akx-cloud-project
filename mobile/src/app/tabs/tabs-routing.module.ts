import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { TabsPage } from './tabs.page';

const routes: Routes = [
  {
    path: '',
    component: TabsPage,
    children: [
      {
        path: 'chat',
        loadChildren: () => import('../home/home.module').then((m) => m.HomePageModule),
      },
      {
        path: 'archivos',
        loadChildren: () => import('../archivos/archivos.module').then((m) => m.ArchivosPageModule),
      },
      {
        path: 'facturas',
        loadChildren: () => import('../facturas/facturas.module').then((m) => m.FacturasPageModule),
      },
      {
        path: 'papelera',
        loadChildren: () => import('../papelera/papelera.module').then((m) => m.PapeleraPageModule),
      },
      {
        path: 'perfil',
        loadChildren: () => import('../perfil/perfil.module').then((m) => m.PerfilPageModule),
      },
      {
        path: '',
        redirectTo: 'chat',
        pathMatch: 'full',
      },
    ],
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class TabsPageRoutingModule {}
