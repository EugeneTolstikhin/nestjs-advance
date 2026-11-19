import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
export class ReturnLineDto {
  @IsUUID('4') productId: string;
  @IsInt() @Min(1) @Max(999) quantity: number;
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
}
export class CreateReturnDto {
  @IsUUID('4') id: string;
  @IsUUID('4') checkoutId: string;
  @IsUUID('4') sellerOrderId: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  items: ReturnLineDto[];
}
export class InspectionLineDto {
  @IsUUID('4') productId: string;
  @IsInt() @Min(0) @Max(999) received: number;
  @IsInt() @Min(0) @Max(999) sellable: number;
  @IsInt() @Min(0) @Max(999) restock: number;
  @IsInt() @Min(0) @Max(999) refund: number;
}
export class ReturnActionDto {
  @IsOptional() @IsInt() @Min(0) @Max(2147483647) shippingRefundCents?: number;
  @IsInt() @Min(1) revision: number;
  @IsIn([
    'approve',
    'reject',
    'inspect',
    'message',
    'ask_buyer',
    'close_issue',
    'carrier_claim',
    'resolve',
    'retry_refund',
  ])
  action: string;
  @IsOptional() @IsString() @MaxLength(3000) notes?: string;
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => InspectionLineDto)
  items?: InspectionLineDto[];
}
export class ReturnIdDto {
  @IsUUID('4') id: string;
}
export class EvidenceIdDto extends ReturnIdDto {
  @IsUUID('4') evidenceId: string;
}
