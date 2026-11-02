import { Body, Controller, Get, Header, HttpCode, Post, Render, Req, Res, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Response } from 'express';
import { AuthService } from '../auth.service';
import { BuyerProfileDto, SellerProfileDto, TypeOfUser } from '../auth.dto';
import { SessionAuthGuard } from '../guard/session-auth.guard';
import { SameOriginGuard } from '../guard/same-origin.guard';
import type { AuthRequest } from '../utils/auth-request';
import { setSessionCookie } from '../utils/browser-session';
import { MaskPii } from '../../interceptor/pii/mask-pii.decorator';
import { accountForms } from './account-form';

@Controller('account')
@UseGuards(SameOriginGuard, SessionAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
@MaskPii(false) // Only the authenticated account owner can read these profiles.
export class AccountController {
    constructor(private readonly auth: AuthService) {}

    @Get()
    @Header('Cache-Control', 'no-store')
    @Render('auth/account')
    async page(@Req() request: AuthRequest) {
        const account = await this.auth.account(request.user!.sub);
        return { title: 'Your account', user: account.user };
    }

    @Get('schema')
    @Header('Cache-Control', 'no-store')
    async schema(@Req() request: AuthRequest) {
        return accountForms(await this.auth.account(request.user!.sub));
    }

    @Post('buyer')
    @HttpCode(200)
    async buyer(@Req() request: AuthRequest, @Body() dto: BuyerProfileDto, @Res({ passthrough: true }) response: Response) {
        const session = await this.auth.saveProfile(request.user!.sub, TypeOfUser.Buyer, dto);
        setSessionCookie(response, session.access_token);
        return session;
    }

    @Post('seller')
    @HttpCode(200)
    async seller(@Req() request: AuthRequest, @Body() dto: SellerProfileDto, @Res({ passthrough: true }) response: Response) {
        const session = await this.auth.saveProfile(request.user!.sub, TypeOfUser.Seller, dto);
        setSessionCookie(response, session.access_token);
        return session;
    }
}
