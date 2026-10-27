import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthDto, PhoneRegisterDto, RegisterDto, TypeOfUser, UserDto } from './auth.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
    private users: UserDto[] = [];
    private nextId = 1;

    constructor(private readonly jwtService: JwtService) {}

    async register(user: RegisterDto) {
        if (user.password !== user.confirmPassword) {
            throw new BadRequestException('Passwords do not match');
        }
        if (![TypeOfUser.Buyer, TypeOfUser.Seller].includes(user.typeOfUser)) {
            throw new BadRequestException('You can register only as a buyer or seller');
        }
        const encryptedPassword = await bcrypt.hash(user.password, 10);
        const username = user.username.trim().toLowerCase();
        if (this.users.some(existing => existing.username === username)) {
            throw new ConflictException('Username is already registered');
        }
        const newUser: UserDto = {
            id: this.nextId++, username, encryptedPassword,
            firstName: user.firstName, lastName: user.lastName,
            dob: user.dob, phone: user.phone, pob: user.pob,
            nationality: user.nationality, typeOfUser: user.typeOfUser,
        };
        this.users.push(newUser);
        return this.createSession(newUser);
    }

    registerByPhone(data: PhoneRegisterDto): UserDto {
        const newUser = new UserDto();
        this.users.push(newUser);
        // Implementation for registering a new user by phone
        return newUser;
    }

    async login(user: AuthDto) {
        const existingUser = this.users.find(existing =>
            existing.username === user.username.trim().toLowerCase());
        if (!existingUser || !await bcrypt.compare(user.password, existingUser.encryptedPassword)) {
            throw new UnauthorizedException('Invalid username or password');
        }
        return this.createSession(existingUser);
    }

    private async createSession(user: UserDto) {
        const accessToken = await this.jwtService.signAsync({
            sub: String(user.id), typeOfUser: user.typeOfUser,
        });
        return {
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 900,
            user: { id: user.id, username: user.username, typeOfUser: user.typeOfUser },
        };
    }

    loginByPhone(data: PhoneRegisterDto): { message: string } {
        // Implementation for user login by phone
        return { message: 'Login by phone successful' };
    }

    hashPassword(password: string): string {
        // Implementation for hashing the password
        return bcrypt.hashSync(password, 10);
    }
}
