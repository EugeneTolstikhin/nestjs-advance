import type { Request } from 'express';
import type { TypeOfUser } from '../auth.dto';

export interface AuthenticatedUser {
    sub: string;
    typeOfUser: TypeOfUser;
}

export interface AuthRequest extends Request {
    accessToken?: string;
    user?: AuthenticatedUser;
}

export function extractBearerToken(request: Request): string | undefined {
    return /^Bearer[ \t]+([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
}
