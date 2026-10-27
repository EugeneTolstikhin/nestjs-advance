import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsModule } from './products/products.module';
import { LoggingMiddleware } from './middleware/logging/logging.middleware';
import { AuthModule } from './auth/auth.module';
import { UserInteractionService } from './user-interaction/user-interaction.service';
import { UserInteractionModule } from './user-interaction/user-interaction.module';

@Module({
  imports: [ProductsModule, AuthModule, UserInteractionModule],
  controllers: [AppController],
  providers: [AppService, UserInteractionService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggingMiddleware).forRoutes('*');
  }
}
