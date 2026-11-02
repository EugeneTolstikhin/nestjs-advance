import { Module } from '@nestjs/common';
import { UserInteractionController } from './user-interaction.controller';
import { UserInteractionService } from './user-interaction.service';
import { ConfiguredOtpFactory, JsonOtpConfigSource, OtpConfigSource, OtpFactory } from './configs/otp.config';
import { AuthStorageModule } from '../auth/storage/auth-storage.module';
import { SameOriginGuard } from '../auth/guard/same-origin.guard';

@Module({
  imports: [AuthStorageModule],
  controllers: [UserInteractionController],
  providers: [
    SameOriginGuard,
    UserInteractionService,
    { provide: OtpConfigSource, useClass: JsonOtpConfigSource },
    { provide: OtpFactory, useClass: ConfiguredOtpFactory },
  ],
  exports: [UserInteractionService, OtpFactory],
})
export class UserInteractionModule {}
