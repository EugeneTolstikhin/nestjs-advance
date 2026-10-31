import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, Observable } from 'rxjs';
import { MASK_PII_KEY } from './mask-pii.decorator';

@Injectable()
export class PiiInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // A method's explicit setting overrides the controller's setting.
    const shouldMask = this.reflector.getAllAndOverride<boolean>(MASK_PII_KEY, [
      context.getHandler(),
      context.getClass(),
    ]) ?? true;

    return next.handle().pipe(
      map((data: unknown) => shouldMask ? this.maskResponse(data) : data),
    );
  }

  private maskResponse(data: unknown): unknown {
    if (Array.isArray(data)) {
      return data.map(value => this.maskResponse(value));
    }
    if (data === null || typeof data !== 'object') {
      return data;
    }
    // Preserve special values so normal response serialization still works.
    if (data instanceof Date || Buffer.isBuffer(data)) {
      return data;
    }

    return Object.fromEntries(
      Object.entries(data).filter(([key]) => ![
        'password', 'confirmpassword', 'encryptedpassword', 'passwordhash',
      ].includes(key.toLowerCase())).map(([key, value]) => {
        const field = key.toLowerCase();
        if (value === null || value === undefined) {
          return [key, value];
        }
        if (['dob', 'dateofbirth', 'pob', 'nationality', 'address'].includes(field)) {
          return [key, '[REDACTED]'];
        }
        if (['email', 'username', 'firstname', 'lastname', 'phone'].includes(field)) {
          // Unexpected shapes must not accidentally expose the sensitive value.
          if (typeof value !== 'string') {
            return [key, '[REDACTED]'];
          }
          if (field === 'email' || field === 'username') {
            const at = value.lastIndexOf('@');
            if (at <= 0) return [key, '[REDACTED]'];
            // Always hide at least one character, including short email names.
            const visible = Math.min(2, at - 1);
            return [key, value.slice(0, visible) + '*'.repeat(at - visible) + value.slice(at)];
          }
          if (field === 'phone') {
            const visible = value.length > 2 ? 2 : 0;
            return [key, '*'.repeat(value.length - visible) + (visible ? value.slice(-visible) : '')];
          }
          const visible = value.length > 1 ? 1 : 0;
          return [key, value.slice(0, visible) + '*'.repeat(value.length - visible)];
        }
        return [key, this.maskResponse(value)];
      }),
    );
  }
}
