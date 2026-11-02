import { TypeOfUser } from '../auth.dto';

// Accept old signed tokens during their remaining 15-minute lifetime. If roles
// is present it must be valid; a malformed array cannot fall back to a legacy role.
export function userRoles(value: { roles?: unknown; typeOfUser?: unknown }): TypeOfUser[] {
    const roles = value.roles === undefined ? [value.typeOfUser] : value.roles;
    if (!Array.isArray(roles) || !roles.length ||
        !roles.every(role => Object.values(TypeOfUser).includes(role))) return [];
    return [...new Set(roles)] as TypeOfUser[];
}
