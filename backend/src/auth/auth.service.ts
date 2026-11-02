import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthDto, RegisterDto } from './auth.dto';
import { RegistrationService } from './registration.service';
import { StoredUser, UsersRepository } from './users.repository';

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
        return {
            access_token: await this.jwtService.signAsync({ sub: user._id, typeOfUser: user.typeOfUser }),
            token_type: 'Bearer',
            expires_in: 900,
            user: this.publicUser(user),
        };
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

    hashPassword(password: string): string {
        return bcrypt.hashSync(password, 10);
    }

    private publicUser(user: StoredUser) {
        return {
            id: user._id,
            username: user.email ?? user.phone,
            name: `${user.firstName} ${user.lastName}`,
            typeOfUser: user.typeOfUser,
        };
    }
}
