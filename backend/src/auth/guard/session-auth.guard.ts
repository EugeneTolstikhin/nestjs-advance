import { Injectable } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthRequest } from '../utils/auth-request';
import { sessionToken } from '../utils/browser-session';

// Only account routes opt into cookie authentication; their mutations also use
// SameOriginGuard. Product APIs continue to require an explicit Bearer token.
@Injectable()
export class SessionAuthGuard extends AuthGuard {
    protected getToken(request: AuthRequest) {
        return super.getToken(request) ?? sessionToken(request);
    }
}
