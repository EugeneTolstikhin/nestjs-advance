import { IsIn, IsInt, IsString, Matches, MaxLength, Min } from 'class-validator';
import { MEDIA_TYPES } from './media.config';

export class UploadTicketDto {
    @IsString() @MaxLength(255) @Matches(/\S/) name: string;
    @IsIn(MEDIA_TYPES) type: string;
    @IsInt() @Min(1) size: number;
}
