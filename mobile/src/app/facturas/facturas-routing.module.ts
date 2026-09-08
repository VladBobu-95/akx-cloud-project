import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { FacturasPage } from './facturas.page';

const routes: Routes = [{ path: '', component: FacturasPage }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class FacturasPageRoutingModule {}
