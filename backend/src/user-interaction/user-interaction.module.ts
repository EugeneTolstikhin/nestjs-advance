import { Module } from '@nestjs/common';
import { UserInteractionController } from './user-interaction.controller';
import { UserInteractionService } from './user-interaction.service';
import { ConfiguredOtpFactory, JsonOtpConfigSource, OtpConfigSource, OtpFactory } from './configs/otp.config';
import { AuthStorageModule } from '../auth/storage/auth-storage.module';
import { SameOriginGuard } from '../auth/guard/same-origin.guard';
import { JobsModule } from '../jobs/job-queue';
import { QueuedOtpFactory } from './queued-otp.factory';

@Module({
  imports: [AuthStorageModule, JobsModule],
  controllers: [UserInteractionController],
  providers: [
    SameOriginGuard,
    UserInteractionService,
    { provide: OtpConfigSource, useClass: JsonOtpConfigSource },
    ConfiguredOtpFactory,
    { provide: OtpFactory, useClass: QueuedOtpFactory },
  ],
  exports: [UserInteractionService, OtpFactory],
})
export class UserInteractionModule {}
