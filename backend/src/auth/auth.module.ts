import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guard/auth.guard';

@Module({
    imports: [JwtModule.registerAsync({
        useFactory: () => {
            const secret = process.env.JWT_SECRET;
            if (!secret || secret.length < 32) {
                throw new Error('Set JWT_SECRET to a random secret of at least 32 characters');
            }
            return {
                secret,
                signOptions: {
                    algorithm: 'HS256' as const,
                    expiresIn: '15m' as const,
                    issuer: 'nestjs-advance',
                    audience: 'nestjs-advance-api',
                },
                verifyOptions: {
                    algorithms: ['HS256' as const],
                    issuer: 'nestjs-advance',
                    audience: 'nestjs-advance-api',
                },
            };
        },
    })],
    controllers: [AuthController],
    providers: [AuthService, AuthGuard],
    exports: [JwtModule, AuthGuard, AuthService],
})
export class AuthModule {}
