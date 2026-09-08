import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular/lazy';
import { FormsModule } from '@angular/forms';
import { FacturasPage } from './facturas.page';
import { FacturasPageRoutingModule } from './facturas-routing.module';
import { SharedModule } from '../shared/shared.module';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, FacturasPageRoutingModule, SharedModule],
  declarations: [FacturasPage],
})
export class FacturasPageModule {}
