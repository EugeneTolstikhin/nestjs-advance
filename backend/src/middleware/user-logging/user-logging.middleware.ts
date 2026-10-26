import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AuthService } from '../../auth/auth.service';

@Injectable()
export class UserLoggingMiddleware implements NestMiddleware {
  constructor(private readonly authService: AuthService) {}
  use(req: Request, res: Response, next: NextFunction) {
    if (req.body && req.body.password) {
      const hashedPassword = this.authService.hashPassword(req.body.password);
      req.body.password = hashedPassword;
    }
    next();
  }
}
