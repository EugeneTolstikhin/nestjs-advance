import { Body, Controller, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { UserInteractionService } from './user-interaction.service';
import { SendOtpDto } from './dto/send-otp.dto';

@Controller('user-interaction')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class UserInteractionController {
    constructor( private readonly userInteractionService: UserInteractionService) {}
    @Post()
    sendOtp(@Body() dto: SendOtpDto = {}) {
        return this.userInteractionService.sendOtp(dto.recipient);
    }
}
