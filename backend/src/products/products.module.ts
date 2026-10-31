import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { TokenMiddleware } from '../middleware/token/token.middleware';
import { AuthModule } from '../auth/auth.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Product as ProductEntity } from './products.dto';

@Module({
    imports: [AuthModule, TypeOrmModule.forFeature([ProductEntity])],
    controllers: [ProductsController],
    providers: [ProductsService],
})
export class ProductsModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(TokenMiddleware).forRoutes(
            { path: 'products', method: RequestMethod.POST },
            { path: 'products/:id', method: RequestMethod.PUT },
            { path: 'products/:id', method: RequestMethod.PATCH },
            { path: 'products/:id', method: RequestMethod.DELETE },
        );
    }
}
