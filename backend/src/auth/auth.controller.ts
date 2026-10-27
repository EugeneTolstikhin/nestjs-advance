import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { AuthDto, PhoneRegisterDto, RegisterDto } from './auth.dto';
import { PhoneAuthPipe } from './customPipe/phoneAuth';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    @Post('login')
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    login(
        @Body('user') user: AuthDto,
    ) {
        return this.authService.login(user);
    }

    @Post('register')
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    register(
        @Body('user') user: RegisterDto,
    ) {
        return this.authService.register(user);
    }

    @Post('register-by-phone')
    @UsePipes(ValidationPipe, PhoneAuthPipe)
    registerByPhone(
        @Body('phone') user: PhoneRegisterDto,
    ) {
        return { message: 'Registration by phone successful' };
    }
}
