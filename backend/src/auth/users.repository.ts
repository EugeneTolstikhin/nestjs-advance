import { ConflictException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Collection, MongoClient, MongoServerError } from 'mongodb';
import type { BuyerProfileDto, Nationality, SellerProfileDto, TypeOfUser } from './auth.dto';

export interface StoredUser {
    _id: string;
    email?: string;
    phone?: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    dob: string;
    pob?: string;
    nationality: Nationality;
    typeOfUser: TypeOfUser.Buyer | TypeOfUser.Seller;
    profile: BuyerProfileDto | SellerProfileDto;
    emailVerifiedAt?: Date;
    phoneVerifiedAt?: Date;
    createdAt: Date;
    updatedAt: Date;
}

@Injectable()
export class UsersRepository implements OnModuleDestroy {
    private client?: MongoClient;
    private collectionPromise?: Promise<Collection<StoredUser>>;

    // Connect lazily so public product pages can run independently of MongoDB.
    private collection(): Promise<Collection<StoredUser>> {
        if (!this.collectionPromise) {
            this.collectionPromise = this.connect().catch(async () => {
                await this.client?.close();
                this.collectionPromise = undefined;
                throw new ServiceUnavailableException('User database is unavailable. Start the local MongoDB service.');
            });
        }
        return this.collectionPromise;
    }

    private async connect(): Promise<Collection<StoredUser>> {
        this.client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017', {
            serverSelectionTimeoutMS: 5000,
        });
        await this.client.connect();
        const collection = this.client.db(process.env.MONGODB_DATABASE ?? 'nestjs_advance').collection<StoredUser>('users');
        await collection.createIndex({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
        await collection.createIndex({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
        return collection;
    }

    async contactExists(email?: string, phone?: string): Promise<boolean> {
        const alternatives: ({ email: string } | { phone: string })[] = [];
        if (email) alternatives.push({ email });
        if (phone) alternatives.push({ phone });
        if (!alternatives.length) return false;
        return Boolean(await (await this.collection()).findOne({ $or: alternatives }, { projection: { _id: 1 } }));
    }

    async insertVerified(user: StoredUser): Promise<StoredUser> {
        try {
            await (await this.collection()).insertOne(user);
            return user;
        } catch (error) {
            if (error instanceof MongoServerError && error.code === 11000) {
                throw new ConflictException('Email or phone is already registered');
            }
            throw error;
        }
    }

    async findByContact(contact: string): Promise<StoredUser | null> {
        const filter = contact.includes('@') ? { email: contact.toLowerCase() } : { phone: contact };
        return (await this.collection()).findOne(filter);
    }

    async findById(id: string): Promise<StoredUser | null> {
        return (await this.collection()).findOne({ _id: id });
    }

    async onModuleDestroy(): Promise<void> {
        await this.client?.close();
    }
}
