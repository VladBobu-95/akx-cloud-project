import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular/lazy';
import { FormsModule } from '@angular/forms';
import { ArchivosPage } from './archivos.page';
import { ArchivosPageRoutingModule } from './archivos-routing.module';
import { SharedModule } from '../shared/shared.module';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, ArchivosPageRoutingModule, SharedModule],
  declarations: [ArchivosPage],
})
export class ArchivosPageModule {}
