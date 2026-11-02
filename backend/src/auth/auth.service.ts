import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthDto, BuyerProfileDto, RegisterDto, SellerProfileDto, TypeOfUser } from './auth.dto';
import { RegistrationService } from './registration.service';
import { StoredUser, UsersRepository } from './users.repository';
import { userRoles } from './utils/user-roles';

@Injectable()
export class AuthService {
    constructor(
        private readonly jwtService: JwtService,
        private readonly users: UsersRepository,
        private readonly registration: RegistrationService,
    ) {}

    register(user: RegisterDto, requester?: string) {
        return this.registration.start(user, requester);
    }

    async login(dto: AuthDto) {
        const user = await this.users.findByContact(dto.username.trim());
        if (!user || !await bcrypt.compare(dto.password, user.passwordHash)) {
            throw new UnauthorizedException('Invalid username or password');
        }
        return this.createSession(user);
    }

    async createSession(user: StoredUser) {
        const roles = userRoles(user);
        if (!roles.length) throw new UnauthorizedException('Account has no valid roles');
        return {
            access_token: await this.jwtService.signAsync({ sub: user._id, roles }),
            token_type: 'Bearer',
            expires_in: 900,
            user: this.publicUser(user),
        };
    }

    async account(id: string) {
        const user = await this.users.findById(id);
        if (!user) throw new UnauthorizedException('Account no longer exists');
        return { user: this.publicUser(user), buyerProfile: user.buyerProfile ?? {}, sellerProfile: user.sellerProfile ?? {} };
    }

    async saveProfile(id: string, role: TypeOfUser.Buyer | TypeOfUser.Seller, profile: BuyerProfileDto | SellerProfileDto) {
        const user = await this.users.saveProfile(id, role, profile);
        if (!user) throw new UnauthorizedException('Account no longer exists');
        return this.createSession(user);
    }

    async browserUser(token: string) {
        try {
            const payload = await this.jwtService.verifyAsync<Record<string, unknown>>(token);
            if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
            const user = await this.users.findById(payload.sub);
            return user ? this.publicUser(user) : null;
        } catch {
            return null;
        }
    }

    private publicUser(user: StoredUser) {
        return {
            id: user._id,
            username: user.email ?? user.phone,
            name: `${user.firstName} ${user.lastName}`,
            roles: userRoles(user),
        };
    }
}
