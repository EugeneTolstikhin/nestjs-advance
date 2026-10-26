import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { ProductsModule } from './products/products.module';
import { AuthController } from './auth/auth.controller';
import { LoggingMiddleware } from './middleware/logging/logging.middleware';
import { AuthService } from './auth/auth.service';

@Module({
  imports: [ProductsModule],
  controllers: [AppController, ProductsController, AuthController],
  providers: [AppService, ProductsService, AuthService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggingMiddleware).forRoutes('*');
  }
}
