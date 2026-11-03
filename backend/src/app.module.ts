import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { BrowserUserMiddleware } from './auth/browser-user.middleware';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ProductsModule } from './products/products.module';
import { LoggingMiddleware } from './middleware/logging/logging.middleware';
import { AuthModule } from './auth/auth.module';
import { UserInteractionModule } from './user-interaction/user-interaction.module';
import { PiiInterceptor } from './interceptor/pii/pii.interceptor';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';

@Module({
  imports: [
    ProductsModule,
    AuthModule,
    UserInteractionModule,
    TypeOrmModule.forRoot({
      type: 'better-sqlite3',
      database: join(__dirname, '..', 'database.sqlite'),
      entities: [join(__dirname, '**', '*.entity{.ts,.js}')],
      synchronize: process.env.NODE_ENV !== 'production',
    })
  ],
  controllers: [AppController],
  providers: [AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: PiiInterceptor,
    }
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggingMiddleware).forRoutes('*');
    consumer.apply(BrowserUserMiddleware).forRoutes(
      { path: 'shop', method: RequestMethod.GET },
      { path: 'shop/new', method: RequestMethod.GET },
      { path: 'shop/:id/edit', method: RequestMethod.GET },
      { path: 'auth/register', method: RequestMethod.GET },
      { path: 'auth/login', method: RequestMethod.GET },
    );
  }
}
