import {
    All,
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    Param,
    Post,
    Req,
    Res,
    UnauthorizedException,
    UseGuards,
    UsePipes,
    ValidationPipe
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Response } from 'express';
import { SessionAuthGuard } from '../../auth/guard/session-auth.guard';
import { SameOriginGuard } from '../../auth/guard/same-origin.guard';
import { Roles } from '../../auth/guard/roles.decorator';
import { TypeOfUser } from '../../auth/auth.dto';
import type { AuthRequest } from '../../auth/utils/auth-request';
import { extractBearerToken } from '../../auth/utils/auth-request';
import { sessionToken } from '../../auth/utils/browser-session';
import { GetProductByIdDto } from '../products.dto';
import { ProductMediaService } from './product-media.service';
import { MediaOriginGuard } from './media-origin.guard';
import { UploadTicketDto } from './media.dto';
import { AuthStateStore } from '../../auth/storage/auth-state.store';
import { sendMediaFile } from './send-media-file';

@Controller('media')
export class ProductMediaController {
    constructor(private readonly media: ProductMediaService, private readonly jwt: JwtService, private readonly state: AuthStateStore) {}
    @Get('config')
    settings() { return this.media.settings(); }

    @Post('tickets')
    @UseGuards(SameOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    async ticket(@Body() dto: UploadTicketDto, @Req() request: AuthRequest) {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        await this.state.limit(`media:tickets:${request.user.sub}`, 30, 3600_000);
        return this.media.ticket(dto, request.user.sub);
    }

    @Get('tickets/:id')
    @UseGuards(SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    @UsePipes(new ValidationPipe())
    status(@Param() dto: GetProductByIdDto, @Req() request: AuthRequest) {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.media.status(dto.id, request.user.sub);
    }

    @Delete('tickets/:id')
    @HttpCode(204)
    @UseGuards(MediaOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    @UsePipes(new ValidationPipe())
    async discard(@Param() dto: GetProductByIdDto, @Req() request: AuthRequest) {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        await this.media.discard(dto.id, request.user.sub);
    }

    @All(['uploads', 'uploads/*path'])
    @UseGuards(MediaOriginGuard, SessionAuthGuard)
    @Roles(TypeOfUser.Seller)
    upload(@Req() request: AuthRequest, @Res() response: Response) {
        if (!request.user) {
            throw new UnauthorizedException('User not authenticated');
        }
        return this.media.handle(request, response, request.user.sub);
    }

    @Get(['files/:id', 'files/:id/poster'])
    @UsePipes(new ValidationPipe())
    async file(@Param() dto: GetProductByIdDto, @Req() request: AuthRequest, @Res() response: Response) {
        let owner: string | undefined;
        try {
            const token = extractBearerToken(request) ?? sessionToken(request);
            if (token) { const payload = await this.jwt.verifyAsync<{ sub: string }>(token); owner = payload.sub; }
        } catch { /* Public published media does not require a session. */ }
        const file = await this.media.file(dto.id, owner, request.path.endsWith('/poster'));
        if (request.aborted || response.destroyed || response.socket?.destroyed) return;
        response.setHeader('Content-Type', file.type);
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Cache-Control', file.published ? 'public, max-age=300' : 'private, no-store');
        return sendMediaFile(request, response, file.path);
    }
}
