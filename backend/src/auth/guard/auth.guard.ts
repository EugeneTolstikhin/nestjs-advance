import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthRequest, extractBearerToken } from '../utils/auth-request';
import { TypeOfUser } from '../auth.dto';
import { ROLES_KEY } from './roles.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService, private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const roles = this.reflector.getAllAndOverride<TypeOfUser[]>(ROLES_KEY, [
      context.getHandler(), context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const token = request.accessToken ?? extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('A Bearer token is required');
    }

    let payload: Record<string, unknown>;
    try {
      // Verification checks the signature, expiry, issuer and audience before trusting claims.
      payload = await this.jwtService.verifyAsync<Record<string, unknown>>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (typeof payload.sub !== 'string' || !payload.sub ||
        typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) ||
        !Object.values(TypeOfUser).includes(payload.typeOfUser as TypeOfUser)) {
      throw new UnauthorizedException('Invalid token claims');
    }
    request.user = { sub: payload.sub, typeOfUser: payload.typeOfUser as TypeOfUser };
    if (roles?.length && !roles.includes(request.user.typeOfUser)) {
      throw new ForbiddenException('Your user type cannot perform this operation');
    }
    return true;
  }
}
