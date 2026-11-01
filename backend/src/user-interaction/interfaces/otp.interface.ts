export interface OtpInterface {
    sendOtp(recipient?: string): Promise<{ message: string }>;
}
