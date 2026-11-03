import { ValidateIf, ArrayMaxSize, ArrayUnique, IsArray, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from "class-validator";

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

}

export class CreateProductDto {
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

export class UpdateProductDto {
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

export class PatchProductDto {
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
