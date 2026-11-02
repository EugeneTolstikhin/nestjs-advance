import { BadRequestException, Body, Controller, HttpCode, Post, Req, Res, UseGuards, UseInterceptors, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthDto, LoginOtpDto, RegisterDto, ResendRegistrationDto, VerifyLoginDto, VerifyRegistrationDto } from './auth.dto';
import { AuthService } from './auth.service';
import { DurationInterceptor } from '../interceptor/duration/duration.interceptor';
import { RegistrationService } from './registration.service';
import { SameOriginGuard } from './guard/same-origin.guard';
import { clearSessionCookie, setSessionCookie } from './utils/browser-session';
import { LoginService } from './login.service';

@Controller('auth')
@UseGuards(SameOriginGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class AuthController {
    constructor(private readonly authService: AuthService, private readonly registration: RegistrationService,
        private readonly logins: LoginService) {}

    @Post('logout')
    @HttpCode(204)
    logout(@Res({ passthrough: true }) response: Response) {
        // Also clear expired or invalid sessions; logging out never requires a valid JWT.
        clearSessionCookie(response);
    }

    @Post('login')
    @UseInterceptors(DurationInterceptor)
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    async login(
        @Body('user') user: AuthDto,
        @Res({ passthrough: true }) response: Response,
        @Req() request: Request,
    ) {
        const session = await this.logins.password(user, request.ip);
        setSessionCookie(response, session.access_token);
        return session;
    }

    @Post('login/otp')
    @HttpCode(202)
    requestLoginCode(@Body() dto: LoginOtpDto, @Req() request: Request) {
        return this.logins.start(dto, request.ip);
    }

    @Post('login/otp/verify')
    @HttpCode(200)
    async verifyLoginCode(@Body() dto: VerifyLoginDto, @Res({ passthrough: true }) response: Response) {
        const session = await this.logins.verify(dto.challengeId, dto.code);
        setSessionCookie(response, session.access_token);
        return session;
    }

    @Post('register')
    @HttpCode(202)
    @UseInterceptors(DurationInterceptor)
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    register(
        @Body('user') user: RegisterDto,
        @Req() request: Request,
    ) {
        return this.authService.register(user, request.ip);
    }

    @Post('register/verify')
    @HttpCode(200)
    async verifyRegistration(@Body() dto: VerifyRegistrationDto, @Res({ passthrough: true }) response: Response) {
        const result = await this.registration.verify(dto.challengeId, dto.channel, dto.code);
        if (!result.registered) return result;
        const session = await this.authService.createSession(result.user);
        setSessionCookie(response, session.access_token);
        return { registered: true, ...session };
    }

    @Post('register/resend')
    @HttpCode(200)
    resendRegistration(@Body() dto: ResendRegistrationDto) {
        return this.registration.resend(dto.challengeId, dto.channel);
    }

    @Post('register-by-phone')
    registerByPhone() {
        throw new BadRequestException('Use /auth/register with a phone number and complete OTP verification');
    }
}
