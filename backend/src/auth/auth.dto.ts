import { IsEmail, IsNotEmpty, IsString, Matches, MinLength, IsOptional, IsEnum, IsDateString } from "class-validator";

export class AuthDto {
    @IsNotEmpty()
    @IsEmail()
    username: string;

    @IsNotEmpty()
    @IsString()
    @MinLength(6)
    @Matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,}$/,
        { message: 'Password must include uppercase and lowercase letters, a number, and a special character (@$!%*?&), using only these characters.' }
    )
    password: string;
}

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

export class RegisterDto {
    @IsNotEmpty()
    @IsEmail()
    username: string;

    @IsNotEmpty()
    @IsString()
    @MinLength(6)
    @Matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{6,}$/,
        { message: 'Password must include uppercase and lowercase letters, a number, and a special character (@$!%*?&), using only these characters.' }
    )
    password: string;

    @IsNotEmpty()
    @IsString()
    @MinLength(6)
    confirmPassword: string;

    @IsNotEmpty()
    @IsString()
    firstName: string;

    @IsNotEmpty()
    @IsString()
    lastName: string;

    @IsNotEmpty()
    @IsDateString()
    dob: Date;

    @IsOptional()
    @IsString()
    @Matches(/^\+?[1-9]\d{1,14}$/, { message: 'Phone number must be in E.164 format' })
    phone: string;

    @IsOptional()
    @IsString()
    pob: string;

    @IsNotEmpty()
    @IsEnum(Nationality)
    nationality: Nationality;
}

export class PhoneRegisterDto {
    @IsNotEmpty()
    @IsString()
    @Matches(/^\+?[1-9]\d{1,14}$/, { message: 'Phone number must be in E.164 format' })
    phone: string;
}