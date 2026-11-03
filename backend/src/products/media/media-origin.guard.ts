import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

@Injectable()
export class MediaOriginGuard implements CanActivate {
    canActivate(context: ExecutionContext) {
        const request = context.switchToHttp().getRequest<Request>();
        const origin = request.get('origin');
        if ((origin && origin !== `${request.protocol}://${request.get('host')}`) || request.get('sec-fetch-site') === 'cross-site') {
            throw new ForbiddenException('Cross-origin uploads are not allowed');
        }
        return true;
    }
}
