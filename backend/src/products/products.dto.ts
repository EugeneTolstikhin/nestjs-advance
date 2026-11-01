import { IsNotEmpty, IsNumber, IsOptional, IsString, IsUrl, IsUUID, MaxLength, Min } from "class-validator";

export class Product {
    @IsUUID('4', { message: 'ID must be a valid UUID v4' })
    id: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    name: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    description: string;

    @IsNotEmpty()
    @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
    @Min(0)
    price: number;

    @IsUrl()
    @IsOptional()
    imageUrl?: string;
}

export class CreateProductDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    name: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    description: string;

    @IsNotEmpty()
    @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
    @Min(0)
    price: number;

    @IsUrl()
    @IsOptional()
    imageUrl?: string;
}

export class UpdateProductDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    name: string;

    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    description: string;

    @IsNotEmpty()
    @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
    @Min(0)
    price: number;

    @IsUrl()
    @IsOptional()
    imageUrl?: string;
}

export class PatchProductDto {
    @IsString()
    @IsOptional()
    @MaxLength(100)
    name?: string;

    @IsString()
    @IsOptional()
    @MaxLength(255)
    description?: string;

    @IsOptional()
    @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 })
    @Min(0)
    price?: number;

    @IsUrl()
    @IsOptional()
    imageUrl?: string;
}

export class DeleteProductDto {
    @IsUUID('4', { message: 'ID must be a valid UUID v4' })
    id: string;
}

export class GetProductByIdDto {
    @IsUUID('4', { message: 'ID must be a valid UUID v4' })
    id: string;
}
