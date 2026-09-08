import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular/lazy';
import { FormsModule } from '@angular/forms';
import { PerfilPage } from './perfil.page';
import { PerfilPageRoutingModule } from './perfil-routing.module';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, PerfilPageRoutingModule],
  declarations: [PerfilPage],
})
export class PerfilPageModule {}
