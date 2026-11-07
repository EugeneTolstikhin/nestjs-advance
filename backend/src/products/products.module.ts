import { ProductMedia } from './media/product-media.entity';
import { ProductMediaService } from './media/product-media.service';
import { ProductMediaController } from './media/product-media.controller';
import { MediaOriginGuard } from './media/media-origin.guard';
import { AuthStorageModule } from '../auth/storage/auth-storage.module';
import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Products as ProductEntity } from './products.entity';
import { ProductsPageController } from './pages/view-products.controller';
import { ProductEditorController } from './pages/product-editor.controller';

@Module({
    imports: [AuthModule, AuthStorageModule, TypeOrmModule.forFeature([ProductEntity, ProductMedia])],
    controllers: [ProductMediaController, ProductsController, ProductsPageController, ProductEditorController],
    providers: [ProductsService, ProductMediaService, MediaOriginGuard],
    exports: [ProductsService],
})
export class ProductsModule {}
