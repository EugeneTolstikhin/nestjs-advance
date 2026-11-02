export interface OtpInterface {
    sendOtp(recipient?: string, code?: string): Promise<{ message: string }>;
}
