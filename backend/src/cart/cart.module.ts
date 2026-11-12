import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module';
import { Products } from '../products/products.entity';
import { ProductMedia } from '../products/media/product-media.entity';
import { CartRepository } from './cart.repository';
import { CartService } from './cart.service';
import { CartController } from './cart.controller';
import { CartPageController } from './cart-page.controller';

@Module({
    imports: [AuthModule, TypeOrmModule.forFeature([Products, ProductMedia])],
    exports: [CartRepository],
    providers: [CartRepository, CartService],
    controllers: [CartController, CartPageController],
})
export class CartModule {}
