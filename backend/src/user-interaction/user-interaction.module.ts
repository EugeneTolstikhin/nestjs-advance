import { Module } from '@nestjs/common';
import { UserInteractionController } from './user-interaction.controller';

@Module({
  controllers: [UserInteractionController]
})
export class UserInteractionModule {}
