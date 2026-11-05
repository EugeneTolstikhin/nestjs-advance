import { Controller, Get, Header, Render } from '@nestjs/common';
import { registrationForm } from './registration-form';
import { loginCodeForm, loginForm } from './login-form';
import { emailConfig } from '../../user-interaction/configs/email.config';

@Controller('auth')
export class AuthPagesController {
    @Get('login')
    @Header('Cache-Control', 'no-store')
    @Render('auth/login')
    loginPage() {
        return { title: 'Welcome back', development: process.env.NODE_ENV !== 'production',
            mailpit: emailConfig().provider === 'mailpit' };
    }

    @Get('login/schema')
    loginSchema() {
        return { credentials: loginForm(), verification: loginCodeForm() };
    }

    @Get('register')
    @Header('Cache-Control', 'no-store')
    @Render('auth/register')
    registrationPage() {
        return { title: 'Create an account', mailpit: emailConfig().provider === 'mailpit' };
    }

    @Get('register/schema')
    registrationSchema() {
        return registrationForm();
    }
}
