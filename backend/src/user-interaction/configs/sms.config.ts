export interface SmspitSettings {
    url: string;
    from: string;
    project: string;
    apiKey?: string;
    timeoutMs: number;
}

export function smsConfig(env: NodeJS.ProcessEnv = process.env): {
    provider: 'smspit' | 'LOG' | 'configured'; smspit?: SmspitSettings;
} {
    const production = env.NODE_ENV === 'production';
    const provider = (env.SMS_PROVIDER ?? (production || env.NODE_ENV === 'test' ? 'configured' : 'smspit')).toLowerCase();
    if (provider !== 'smspit' && provider !== 'log' && provider !== 'configured') {
        throw new Error('SMS_PROVIDER must be smspit, LOG or configured');
    }
    if (production && provider !== 'configured') throw new Error('Production requires SMS_PROVIDER=configured and a real provider adapter');
    if (provider !== 'smspit') return { provider: provider === 'log' ? 'LOG' : 'configured' };
    let url: URL;
    try { url = new URL(env.SMSPIT_URL || 'http://127.0.0.1:4300'); }
    catch { throw new Error('SMSPIT_URL must be a valid HTTP(S) base URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('SMSPIT_URL must use HTTP(S) without credentials, query or fragment');
    }
    const from = env.SMS_FROM?.trim() || 'NestShop';
    const project = env.SMSPIT_PROJECT?.trim() || 'default';
    if (/[\r\n]/.test(from) || from.length > 64) throw new Error('SMS_FROM must be a single line of up to 64 characters');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(project)) throw new Error('SMSPIT_PROJECT must contain 1–64 letters, digits, underscores or hyphens');
    const timeoutMs = Number(env.SMS_TIMEOUT_MS || 10000);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new Error('SMS_TIMEOUT_MS must be an integer between 1 and 60000');
    const apiKey = env.SMSPIT_API_KEY || undefined;
    if (apiKey && /[\r\n]/.test(apiKey)) throw new Error('SMSPIT_API_KEY must be a single line');
    return { provider, smspit: { url: url.href.replace(/\/$/, ''), from, project, apiKey, timeoutMs } };
}
