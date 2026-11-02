import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guard/auth.guard';
import { UsersRepository } from './users.repository';
import { RegistrationService } from './registration.service';
import { UserInteractionModule } from '../user-interaction/user-interaction.module';
import { SameOriginGuard } from './guard/same-origin.guard';
import { AuthPagesController } from './pages/auth-pages.controller';
import { LoginService } from './login.service';

@Module({
    imports: [UserInteractionModule, JwtModule.registerAsync({
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
    controllers: [AuthController, AuthPagesController],
    providers: [AuthService, AuthGuard, UsersRepository, RegistrationService, SameOriginGuard, LoginService],
    exports: [JwtModule, AuthGuard, AuthService],
})
export class AuthModule {}
