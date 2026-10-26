import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { AuthDto, PhoneRegisterDto, RegisterDto } from './auth.dto';
import { PhoneAuthPipe } from './customPipe/phoneAuth';

@Controller('auth')
export class AuthController {
    @Post('login')
    login(
        @Body('user') user: AuthDto,
    ) {
        return { message: 'Login successful' };
    }

    @Post('register')
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    register(
        @Body('user') user: RegisterDto,
    ) {
        return { message: 'Registration successful' };
    }

    @Post('register-by-phone')
    @UsePipes(ValidationPipe, PhoneAuthPipe)
    registerByPhone(
        @Body('phone') user: PhoneRegisterDto,
    ) {
        return { message: 'Registration by phone successful' };
    }
}
