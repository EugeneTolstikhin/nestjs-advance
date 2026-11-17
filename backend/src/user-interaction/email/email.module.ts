import { Module } from '@nestjs/common';
import { EmailProviderFactory } from './email-provider';

@Module({
  providers: [EmailProviderFactory],
  exports: [EmailProviderFactory],
})
export class EmailModule {}
