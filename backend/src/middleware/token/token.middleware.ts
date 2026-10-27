import { Injectable, NestMiddleware, UnauthorizedException } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import { AuthRequest, extractBearerToken } from '../../auth/utils/auth-request';

@Injectable()
export class TokenMiddleware implements NestMiddleware {
    use(req: AuthRequest, res: Response, next: NextFunction) {
        const token = extractBearerToken(req);
        if (!token) {
            throw new UnauthorizedException('Authorization must contain Bearer <token>');
        }
        req.accessToken = token;
        next();
    }
}
