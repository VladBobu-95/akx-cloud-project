import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { ArchivosPage } from './archivos.page';

const routes: Routes = [{ path: '', component: ArchivosPage }];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class ArchivosPageRoutingModule {}
