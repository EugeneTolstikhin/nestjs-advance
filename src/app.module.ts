import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { ProductsModule } from './products/products.module';
import { AuthController } from './auth/auth.controller';

@Module({
  imports: [ProductsModule],
  controllers: [AppController, ProductsController, AuthController],
  providers: [AppService, ProductsService],
})
export class AppModule {}
