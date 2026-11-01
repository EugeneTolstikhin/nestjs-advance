import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

export class SendOtpDto {
    @ValidateIf((_object, value: unknown) => value !== undefined)
    @IsString()
    @IsNotEmpty()
    @MaxLength(254)
    recipient?: string;
}
