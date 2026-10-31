import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { map, Observable } from 'rxjs';

@Injectable()
export class PiiInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      // Add your logic here to handle PII data, such as masking or logging
      map((data) => {
        // Example: Masking email addresses in the response data
        if (data && typeof data === 'object' && data.email) {
          data.email = data.email.replace(/(.{2})(.*)(?=@)/, (_, a, b) => a + '*'.repeat(b.length));
        }
        return data;
      }),
    );
  }
}
