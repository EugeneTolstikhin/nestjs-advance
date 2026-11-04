export interface OtpDeliveryOptions {
    expiresAt?: number;
    idempotencyKey?: string;
    validity?: { key: string; digest: string; channel?: 'email' | 'phone'; currentKey?: string; challengeId?: string };
}
export interface OtpInterface {
    readonly delivery?: 'LOG' | 'phone' | 'email';
    sendOtp(recipient?: string, code?: string, options?: OtpDeliveryOptions): Promise<{ message: string }>;
}
