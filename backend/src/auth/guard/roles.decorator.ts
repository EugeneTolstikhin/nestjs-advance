import { SetMetadata } from '@nestjs/common';
import { TypeOfUser } from '../auth.dto';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: TypeOfUser[]) => SetMetadata(ROLES_KEY, roles);
