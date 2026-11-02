import { IsEmail, IsNotEmpty, IsString, Matches, MinLength, MaxLength, IsOptional, IsEnum, IsDateString, IsIn, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum Nationality {
    USA = 'USA',
    Canada = 'Canada',
    UK = 'UK',
    Australia = 'Australia',
    Germany = 'Germany',
    France = 'France',
    Italy = 'Italy',
    Spain = 'Spain',
    Japan = 'Japan',
    China = 'China',
    India = 'India',
    Brazil = 'Brazil',
    Mexico = 'Mexico',
    Russia = 'Russia',
    SouthAfrica = 'South Africa'
}

export enum TypeOfUser {
    Buyer = 'buyer',
    Seller = 'seller',
    Admin = 'admin'
}


export class AuthDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(254)
    username: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(72)
    password: string;
}

export class LoginOtpDto {
    @IsIn(['email', 'phone'])
    channel: 'email' | 'phone';

    @IsString()
    @IsNotEmpty()
    @MaxLength(254)
    contact: string;
}

export class VerifyLoginDto {
    @Matches(/^[a-f0-9]{64}$/)
    challengeId: string;

    @Matches(/^\d{6}$/)
    code: string;
}

export class BuyerProfileDto {
    @IsOptional()
    @IsString()
    @MaxLength(500)
    deliveryAddress?: string;
}

export class SellerProfileDto {
    @IsOptional()
    @IsString()
    @MaxLength(160)
    companyName?: string;

    @IsOptional()
    @IsString()
    @MaxLength(500)
    businessAddress?: string;

    @IsOptional()
    @IsString()
    @MaxLength(40)
    vatNumber?: string;
}

export class RegisterDto {
    @IsOptional()
    @IsEmail()
    @MaxLength(254)
    email?: string;

    // Kept as an email alias for existing API clients. The UI uses email.
    @IsOptional()
    @IsEmail()
    @MaxLength(254)
    username?: string;

    @IsOptional()
    @IsString()
    @Matches(/^\+[1-9]\d{1,14}$/, { message: 'Phone must use E.164 format, for example +4917612345678' })
    phone?: string;

    @IsString()
    @MinLength(6)
    @MaxLength(72)
    @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,}$/)
    password: string;

    @IsString()
    @MinLength(6)
    @MaxLength(72)
    confirmPassword: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Matches(/\S/, { message: 'First name must not be blank' })
    firstName: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Matches(/\S/, { message: 'Last name must not be blank' })
    lastName: string;

    @IsDateString({ strict: true })
    dob: string;

    @IsOptional()
    @IsString()
    @MaxLength(120)
    pob?: string;

    @IsEnum(Nationality)
    nationality: Nationality;

    @IsIn([TypeOfUser.Buyer, TypeOfUser.Seller])
    typeOfUser: TypeOfUser.Buyer | TypeOfUser.Seller;

    @IsOptional()
    @ValidateNested()
    @Type(() => BuyerProfileDto)
    buyerProfile?: BuyerProfileDto;

    @IsOptional()
    @ValidateNested()
    @Type(() => SellerProfileDto)
    sellerProfile?: SellerProfileDto;
}

export class VerifyRegistrationDto {
    @Matches(/^[a-f0-9]{64}$/)
    challengeId: string;

    @IsIn(['email', 'phone'])
    channel: 'email' | 'phone';

    @Matches(/^\d{6}$/)
    code: string;
}

export class ResendRegistrationDto {
    @Matches(/^[a-f0-9]{64}$/)
    challengeId: string;

    @IsIn(['email', 'phone'])
    channel: 'email' | 'phone';
}

export class PhoneRegisterDto {
    @IsString()
    @Matches(/^\+[1-9]\d{1,14}$/)
    phone: string;
}
