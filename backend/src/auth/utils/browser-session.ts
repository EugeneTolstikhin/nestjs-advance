import type { CookieOptions, Request, Response } from 'express';

export const SESSION_COOKIE = 'nest_session';

export function sessionToken(request: Request): string | undefined {
    const match = request.headers.cookie?.split(';').map(value => value.trim())
        .find(value => value.startsWith(`${SESSION_COOKIE}=`));
    if (!match) return undefined;
    try { return decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)); }
    catch { return undefined; }
}

function sessionCookieOptions(): CookieOptions {
    return {
        httpOnly: true, secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax', path: '/',
    };
}

export function setSessionCookie(response: Response, token: string) {
    response.setHeader('Cache-Control', 'no-store');
    response.cookie(SESSION_COOKIE, token, { ...sessionCookieOptions(), maxAge: 15 * 60_000 });
}

export function clearSessionCookie(response: Response) {
    response.clearCookie(SESSION_COOKIE, sessionCookieOptions());
    response.setHeader('Cache-Control', 'no-store');
}
