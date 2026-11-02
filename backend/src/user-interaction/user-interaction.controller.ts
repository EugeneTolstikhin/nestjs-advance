import { Body, Controller, Post, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { UserInteractionService } from './user-interaction.service';
import { SendOtpDto } from './dto/send-otp.dto';
import { AuthStateStore } from '../auth/storage/auth-state.store';
import { SameOriginGuard } from '../auth/guard/same-origin.guard';

@Controller('user-interaction')
@UseGuards(SameOriginGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class UserInteractionController {
    constructor(private readonly userInteractionService: UserInteractionService, private readonly state: AuthStateStore) {}
    @Post()
    async sendOtp(@Req() request: Request, @Body() dto: SendOtpDto = {}) {
        await this.state.limit(`demo:ip:${request.ip}`, 10);
        if (dto.recipient) {
            const recipient = dto.recipient.trim().toLowerCase();
            await this.state.limit(`otp:cooldown:${recipient}`, 1, 60000);
            await this.state.limit(`otp:contact:${recipient}`, 5);
        }
        return this.userInteractionService.sendOtp(dto.recipient);
    }
}
