import { SetMetadata } from '@nestjs/common';

export const MASK_PII_KEY = 'pii:mask';

/** Controls response masking. Access to unmasked data must be authorized separately. */
export const MaskPii = (enabled = true) => SetMetadata(MASK_PII_KEY, enabled);
