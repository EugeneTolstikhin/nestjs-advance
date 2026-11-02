import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnsupportedMediaTypeException } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class SameOriginGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const origin = request.get('origin');
        // CLI/API clients may omit Origin. Browsers include it on cross-origin POSTs.
        if (origin && origin !== `${request.protocol}://${request.get('host')}`) {
            throw new ForbiddenException('Cross-origin authentication requests are not allowed');
        }
        if (request.method === 'POST' && !request.is('application/json')) {
            throw new UnsupportedMediaTypeException('Authentication requests must use application/json');
        }
        return true;
    }
}
