import { isEmail } from 'class-validator';

export interface SmtpSettings {
    host: string;
    port: number;
    secure: boolean;
    requireTLS: boolean;
    user?: string;
    pass?: string;
    from: string;
    timeoutMs: number;
}

export function emailConfig(env: NodeJS.ProcessEnv = process.env): { provider: 'LOG' | 'mailpit' | 'smtp'; smtp?: SmtpSettings } {
    const production = env.NODE_ENV === 'production';
    const provider = (env.EMAIL_PROVIDER ?? (production ? 'smtp' : env.NODE_ENV === 'test' ? 'LOG' : 'mailpit')).toLowerCase();
    if (provider !== 'log' && provider !== 'mailpit' && provider !== 'smtp') throw new Error('EMAIL_PROVIDER must be mailpit, smtp or LOG');
    if (production && provider !== 'smtp') throw new Error('Production requires EMAIL_PROVIDER=smtp');
    if (provider === 'log') return { provider: 'LOG' };

    const boolean = (key: string, fallback: boolean) => {
        if (!env[key]) return fallback;
        if (!['true', 'false'].includes(env[key]!)) throw new Error(`${key} must be true or false`);
        return env[key] === 'true';
    };
    const integer = (key: string, fallback: number, max: number) => {
        const value = Number(env[key] || fallback);
        if (!Number.isInteger(value) || value <= 0 || value > max) throw new Error(`${key} must be an integer between 1 and ${max}`);
        return value;
    };
    const host = env.SMTP_HOST?.trim() || (provider === 'mailpit' ? '127.0.0.1' : '');
    const from = env.SMTP_FROM?.trim() || (provider === 'mailpit' ? 'Nest Shop <no-reply@nest-shop.test>' : '');
    if (!host || /[\s/@]/.test(host)) throw new Error('Set SMTP_HOST to your SMTP server hostname');
    const sender = from.match(/<([^<>]+)>$/)?.[1] ?? from;
    if (/[\r\n]/.test(from) || !isEmail(sender)) throw new Error('Set SMTP_FROM to a valid sender email address');
    const port = integer('SMTP_PORT', provider === 'mailpit' ? 1025 : 587, 65535);
    const secure = boolean('SMTP_SECURE', port === 465);
    const requireTLS = boolean('SMTP_REQUIRE_TLS', production && !secure);
    if (production && !secure && !requireTLS) throw new Error('Production SMTP must use TLS: SMTP_SECURE=true or SMTP_REQUIRE_TLS=true');
    const user = env.SMTP_USER || undefined;
    const pass = env.SMTP_PASS || undefined;
    if (!!user !== !!pass) throw new Error('Set both SMTP_USER and SMTP_PASS, or leave both empty');
    if (production && (!user || !pass)) throw new Error('Set SMTP_USER and SMTP_PASS for your production provider');
    return { provider, smtp: { host, port, secure, requireTLS, user, pass, from,
        timeoutMs: integer('SMTP_TIMEOUT_MS', 10000, 60000) } };
}
