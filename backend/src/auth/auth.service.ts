import { Injectable } from '@nestjs/common';
import { AuthDto, PhoneRegisterDto, RegisterDto, UserDto } from './auth.dto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class AuthService {
    private users: UserDto[] = [];

    register(user: RegisterDto): UserDto {
        const newUser = new UserDto();
        this.users.push(newUser);
        // Implementation for registering a new user
        return newUser;
    }

    registerByPhone(data: PhoneRegisterDto): UserDto {
        const newUser = new UserDto();
        this.users.push(newUser);
        // Implementation for registering a new user by phone
        return newUser;
    }

    login(user: AuthDto): { message: string } {
        // Implementation for user login
        return { message: 'Login successful' };
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
