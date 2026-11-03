import { Injectable } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { AuthRequest } from '../utils/auth-request';
import { sessionToken } from '../utils/browser-session';

// Browser account/product routes opt into cookie authentication. Their mutations
// also use SameOriginGuard. Explicit Bearer tokens remain supported for API clients.
@Injectable()
export class SessionAuthGuard extends AuthGuard {
    protected getToken(request: AuthRequest) {
        return super.getToken(request) ?? sessionToken(request);
    }
}
