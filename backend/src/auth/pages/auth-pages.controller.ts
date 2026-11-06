import { Controller, Get, Header, Render } from '@nestjs/common';
import { registrationForm } from './registration-form';
import { loginCodeForm, loginForm } from './login-form';
import { emailConfig } from '../../user-interaction/configs/email.config';
import { smsConfig } from '../../user-interaction/configs/sms.config';

@Controller('auth')
export class AuthPagesController {
    @Get('login')
    @Header('Cache-Control', 'no-store')
    @Render('auth/login')
    loginPage() {
        return { title: 'Welcome back', development: process.env.NODE_ENV !== 'production',
            mailpit: emailConfig().provider === 'mailpit', smspit: smsConfig().provider === 'smspit' };
    }

    @Get('login/schema')
    loginSchema() {
        return { credentials: loginForm(), verification: loginCodeForm() };
    }

    @Get('register')
    @Header('Cache-Control', 'no-store')
    @Render('auth/register')
    registrationPage() {
        return { title: 'Create an account', mailpit: emailConfig().provider === 'mailpit',
            smspit: smsConfig().provider === 'smspit' };
    }

    @Get('register/schema')
    registrationSchema() {
        return registrationForm();
    }
}
