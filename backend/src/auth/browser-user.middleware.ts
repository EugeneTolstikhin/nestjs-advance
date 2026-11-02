import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AuthService } from './auth.service';
import { sessionToken } from './utils/browser-session';

@Injectable()
export class BrowserUserMiddleware implements NestMiddleware {
    constructor(private readonly auth: AuthService) {}

    async use(request: Request, response: Response, next: NextFunction) {
        const token = sessionToken(request);
        response.locals.user = token ? await this.auth.browserUser(token) : null;
        next();
    }
}
