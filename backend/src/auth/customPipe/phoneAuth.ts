import { Injectable, ArgumentMetadata } from "@nestjs/common";

@Injectable()
export class PhoneAuthPipe {
    transform(value: any, metadata: ArgumentMetadata) {
        if (typeof value !== 'string') {
            throw new Error('Phone number must be a string');
        }
        const phoneRegex = /^\+?[1-9]\d{1,14}$/; // E.164 format
        if (!phoneRegex.test(value)) {
            throw new Error('Invalid phone number format');
        }
        return value;
    }
}