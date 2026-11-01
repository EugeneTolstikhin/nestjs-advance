import { Module } from '@nestjs/common';
import { UserInteractionController } from './user-interaction.controller';
import { UserInteractionService } from './user-interaction.service';
import { ConfiguredOtpFactory, JsonOtpConfigSource, OtpConfigSource, OtpFactory } from './configs/otp.config';

@Module({
  controllers: [UserInteractionController],
  providers: [
    UserInteractionService,
    { provide: OtpConfigSource, useClass: JsonOtpConfigSource },
    { provide: OtpFactory, useClass: ConfiguredOtpFactory },
  ],
  exports: [UserInteractionService, OtpFactory],
})
export class UserInteractionModule {}
