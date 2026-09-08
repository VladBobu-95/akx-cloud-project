import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular/lazy';
import { FormsModule } from '@angular/forms';
import { PapeleraPage } from './papelera.page';
import { PapeleraPageRoutingModule } from './papelera-routing.module';
import { SharedModule } from '../shared/shared.module';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, PapeleraPageRoutingModule, SharedModule],
  declarations: [PapeleraPage],
})
export class PapeleraPageModule {}
