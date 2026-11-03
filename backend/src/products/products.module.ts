import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Products as ProductEntity } from './products.entity';
import { ProductsPageController } from './pages/view-products.controller';
import { ProductEditorController } from './pages/product-editor.controller';

@Module({
    imports: [AuthModule, TypeOrmModule.forFeature([ProductEntity])],
    controllers: [ProductsController, ProductsPageController, ProductEditorController],
    providers: [ProductsService],
})
export class ProductsModule {}
