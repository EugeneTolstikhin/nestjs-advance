import { ConflictException, Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Collection, MongoClient, MongoServerError } from 'mongodb';
import { TypeOfUser } from './auth.dto';
import type { BuyerProfileDto, Nationality, SellerProfileDto } from './auth.dto';
import { userRoles } from './utils/user-roles';

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
    roles: TypeOfUser[];
    buyerProfile?: BuyerProfileDto;
    sellerProfile?: SellerProfileDto;
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
        // Idempotent migration: preserve identity, verified contacts and profile data.
        await collection.updateMany({ roles: { $exists: false }, typeOfUser: { $in: Object.values(TypeOfUser) } }, [
            { $set: {
                roles: ['$typeOfUser'],
                buyerProfile: { $cond: [{ $eq: ['$typeOfUser', TypeOfUser.Buyer] },
                    { $ifNull: ['$buyerProfile', { $ifNull: ['$profile', {}] }] }, { $ifNull: ['$buyerProfile', '$$REMOVE'] }] },
                sellerProfile: { $cond: [{ $eq: ['$typeOfUser', TypeOfUser.Seller] },
                    { $ifNull: ['$sellerProfile', { $ifNull: ['$profile', {}] }] }, { $ifNull: ['$sellerProfile', '$$REMOVE'] }] },
            } },
            { $unset: ['typeOfUser', 'profile'] },
        ]);
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
        // A pending Redis registration may have been created before this upgrade.
        const legacy = user as StoredUser & { typeOfUser?: TypeOfUser; profile?: BuyerProfileDto | SellerProfileDto };
        const normalized: StoredUser = { ...user, roles: userRoles(legacy) };
        if (!normalized.roles.length) throw new Error('User must have at least one valid role');
        if (legacy.typeOfUser === TypeOfUser.Buyer && !normalized.buyerProfile) normalized.buyerProfile = (legacy.profile as BuyerProfileDto) ?? {};
        if (legacy.typeOfUser === TypeOfUser.Seller && !normalized.sellerProfile) normalized.sellerProfile = (legacy.profile as SellerProfileDto) ?? {};
        delete (normalized as typeof legacy).typeOfUser;
        delete (normalized as typeof legacy).profile;
        try {
            await (await this.collection()).insertOne(normalized);
            return normalized;
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

    async saveProfile(id: string, role: TypeOfUser.Buyer | TypeOfUser.Seller, profile: BuyerProfileDto | SellerProfileDto) {
        const field = role === TypeOfUser.Buyer ? 'buyerProfile' : 'sellerProfile';
        const fields = role === TypeOfUser.Buyer ? ['deliveryAddress'] : ['companyName', 'businessAddress', 'vatNumber'];
        const data = Object.fromEntries(Object.entries(profile).filter(([key, value]) => fields.includes(key) && typeof value === 'string'));
        // Each update touches only its own profile; concurrent role additions are safe.
        return (await this.collection()).findOneAndUpdate({ _id: id }, {
            $addToSet: { roles: role }, $set: { [field]: data, updatedAt: new Date() },
        }, { returnDocument: 'after' });
    }

    async onModuleDestroy(): Promise<void> {
        await this.client?.close();
    }
}
