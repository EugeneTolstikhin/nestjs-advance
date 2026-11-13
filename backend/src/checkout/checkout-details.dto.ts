import {
  IsEmail,
  ValidateIf,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  Min,
  Equals,
  IsIn,
} from 'class-validator';

export class CheckoutRevisionDto {
  @IsInt()
  @Min(1)
  revision: number;
}

export class DeliveryDetailsDto extends CheckoutRevisionDto {
  @IsString()
  @Length(2, 100)
  fullName: string;

  @ValidateIf(
    (value: DeliveryDetailsDto) => value.email !== undefined || !value.phone,
  )
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ValidateIf(
    (value: DeliveryDetailsDto) => value.phone !== undefined || !value.email,
  )
  @IsString()
  @Matches(/^\+[1-9]\d{6,14}$/)
  phone?: string;

  @IsString()
  @Length(3, 150)
  addressLine1: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  addressLine2?: string;

  @IsString()
  @Matches(/^\d{5}$/)
  postalCode: string;

  @IsString()
  @Length(2, 100)
  city: string;

  @Equals('DE')
  country: 'DE';
}

export class SelectShippingDto extends CheckoutRevisionDto {
  @IsIn(['standard', 'express'])
  method: 'standard' | 'express';
}

export class StartPaymentDto extends CheckoutRevisionDto {
  @IsString() @Matches(/^[a-z][a-z0-9_]{1,39}$/) optionId: string;
}

export class RetryCheckoutDto extends CheckoutRevisionDto {
  @IsString() @Matches(/^[a-f0-9]{64}$/) quoteHash: string;
}
