import { MAX_PRODUCT_STOCK } from './stock';
import { IsInt, Max, ValidateIf, ArrayMaxSize, ArrayUnique, IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from "class-validator";

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

    @IsUUID('4', { message: 'Seller ID must be a valid UUID v4' })
    sellerId: string;
}

export class CreateProductDto {
    @ValidateIf((_object, value) => value !== undefined)
    @IsInt()
    @Min(0)
    @Max(MAX_PRODUCT_STOCK)
    stock?: number;

    @ValidateIf((_object, value) => value !== undefined)
    @IsArray()
    @ArrayMaxSize(100)
    @ArrayUnique()
    @IsUUID('4', { each: true })
    mediaIds?: string[];

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
}

class StockChangesDto {
    @ValidateIf((_object, value) => value !== undefined)
    @IsInt()
    @Min(0)
    @Max(MAX_PRODUCT_STOCK)
    stock?: number;

    @ValidateIf((_object, value) => value !== undefined)
    @IsInt()
    @Min(0)
    @Max(MAX_PRODUCT_STOCK)
    expectedStock?: number;

    @ValidateIf((_object, value) => value !== undefined)
    @IsInt()
    @Min(1)
    @Max(MAX_PRODUCT_STOCK)
    restockQuantity?: number;
}

export class RestockProductDto {
    @IsInt()
    @Min(1)
    @Max(MAX_PRODUCT_STOCK)
    quantity: number;
}

export class UpdateProductDto extends StockChangesDto {
    @ValidateIf((_object, value) => value !== undefined)
    @IsArray()
    @ArrayMaxSize(100)
    @ArrayUnique()
    @IsUUID('4', { each: true })
    mediaIds?: string[];

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

}

export class PatchProductDto extends StockChangesDto {
    @ValidateIf((_object, value) => value !== undefined)
    @IsArray()
    @ArrayMaxSize(100)
    @ArrayUnique()
    @IsUUID('4', { each: true })
    mediaIds?: string[];

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

}

export class DeleteProductDto {
    @IsUUID('4', { message: 'ID must be a valid UUID v4' })
    id: string;
}

export class GetProductByIdDto {
    @IsUUID('4', { message: 'ID must be a valid UUID v4' })
    id: string;
}
