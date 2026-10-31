import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';
import { PiiInterceptor } from './pii.interceptor';
import { MaskPii } from './mask-pii.decorator';

class DefaultController {
  handle() {}
}

const mask = (value: unknown, controller = DefaultController) => firstValueFrom(
  new PiiInterceptor(new Reflector()).intercept({
    getHandler: () => controller.prototype.handle,
    getClass: () => controller,
  } as unknown as ExecutionContext, { handle: () => of(value) }),
);

describe('PiiInterceptor', () => {
  it('returns original response values when a route explicitly disables masking', async () => {
    class UnmaskedController {
      @MaskPii(false)
      handle() {}
    }
    const data = Object.freeze({ email: 'hello@example.com', firstName: 'Jane' });
    expect(await mask(data, UnmaskedController)).toBe(data);
  });

  it('uses the controller policy when no route policy is specified', async () => {
    @MaskPii(false)
    class UnmaskedController {
      handle() {}
    }
    const data = { email: 'hello@example.com' };
    expect(await mask(data, UnmaskedController)).toBe(data);
  });

  it('lets a route enable masking inside an unmasked controller', async () => {
    @MaskPii(false)
    class UnmaskedController {
      @MaskPii()
      handle() {}
    }
    expect(await mask({ email: 'hello@example.com' }, UnmaskedController))
      .toEqual({ email: 'he***@example.com' });
  });

  it('lets a route disable masking inside a masked controller', async () => {
    @MaskPii()
    class MaskedController {
      @MaskPii(false)
      handle() {}
    }
    const data = { email: 'hello@example.com' };
    expect(await mask(data, MaskedController)).toBe(data);
  });

  it('masks nested users and arrays without mutating request or stored objects', async () => {
    const user = Object.freeze({
      username: 'seller@example.com', email: 'hello@example.com', firstName: 'Jane',
      lastName: 'Smith', phone: '+49123456789', dob: new Date('2000-01-01'),
      nationality: 'Germany', password: 'secret', encryptedPassword: 'hash',
    });
    const request = { body: user };
    const response = Object.freeze({ users: Object.freeze([user]), total: 1, access_token: 'token' });
    expect(await mask(response)).toEqual({
      users: [{ username: 'se****@example.com', email: 'he***@example.com',
        firstName: 'J***', lastName: 'S****', phone: '**********89',
        dob: '[REDACTED]', nationality: '[REDACTED]' }],
      total: 1, access_token: 'token',
    });
    expect(request.body).toBe(user);
    expect(request.body.email).toBe('hello@example.com');
    expect(request.body.password).toBe('secret');
    expect(response.users[0]).toBe(user);
  });

  it('masks short emails and redacts unexpected sensitive field types', async () => {
    expect(await mask([{ email: 'a@example.com' }, { email: 'ab@example.com' },
      { email: 'invalid' }, { phone: { raw: '123456789' } }, { address: { city: 'Berlin' } },
    ])).toEqual([{ email: '*@example.com' }, { email: 'a*@example.com' },
      { email: '[REDACTED]' }, { phone: '[REDACTED]' }, { address: '[REDACTED]' },
    ]);
  });

  it('preserves nulls, primitives, dates and buffers', async () => {
    const date = new Date('2000-01-01');
    const buffer = Buffer.from('file');
    expect(await mask({ email: null, date, buffer, count: 0, enabled: false }))
      .toEqual({ email: null, date, buffer, count: 0, enabled: false });
    expect(await mask(null)).toBeNull();
    expect(await mask('Hello World!')).toBe('Hello World!');
  });
});
