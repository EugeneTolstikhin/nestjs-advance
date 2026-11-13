import { ConflictException, HttpException, Injectable, NotFoundException, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { Collection, MongoClient, MongoServerError } from 'mongodb';

export const CART_MAX_PRODUCTS = 100;
export const CART_MAX_QUANTITY = 99;
export interface StoredCart {
    _id: string; // Authenticated account ID, never a browser/device ID.
    items: Record<string, number>;
    createdAt: Date;
    updatedAt: Date;
    revision?: number;
}

@Injectable()
export class CartRepository implements OnModuleDestroy {
    private client?: MongoClient;
    private connecting?: Promise<Collection<StoredCart>>;
    private collection() {
        if (!this.connecting) this.connecting = this.connect().catch(async error => {
            await this.client?.close(); this.connecting = undefined; throw error;
        });
        return this.connecting;
    }
    private async connect() {
        this.client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 });
        await this.client.connect();
        // MongoDB's built-in unique _id index guarantees one cart per account.
        return this.client.db(process.env.MONGODB_DATABASE ?? 'nestjs_advance').collection<StoredCart>('carts');
    }
    private async run<T>(work: (collection: Collection<StoredCart>) => Promise<T>): Promise<T> {
        try { return await work(await this.collection()); }
        catch (error) {
            if (error instanceof HttpException) throw error;
            throw new ServiceUnavailableException('Shopping cart storage is unavailable. Check MongoDB.');
        }
    }
    get(userId: string) { return this.run(collection => collection.findOne({ _id: userId })); }

    add(userId: string, productId: string, maxQuantity = CART_MAX_QUANTITY) {
        return this.run(async collection => {
            try {
                await collection.updateOne({ _id: userId }, { $setOnInsert: {
                    items: {}, createdAt: new Date(), updatedAt: new Date(),
                } }, { upsert: true });
            } catch (error) {
                // Concurrent first additions can race to create the same unique account cart.
                if (!(error instanceof MongoServerError && error.code === 11000)) throw error;
            }
            const path = `items.${productId}`;
            const cart = await collection.findOneAndUpdate({ _id: userId, $expr: { $and: [
                { $lt: [{ $ifNull: [`$${path}`, 0] }, maxQuantity] },
                { $or: [ { $ne: [{ $type: `$${path}` }, 'missing'] },
                    { $lt: [{ $size: { $objectToArray: '$items' } }, CART_MAX_PRODUCTS] } ] },
            ] } }, { $inc: { [path]: 1, revision: 1 }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' });
            if (!cart) throw new ConflictException(`Cart limit reached: up to ${maxQuantity} units of this product, subject to stock, and ${CART_MAX_PRODUCTS} different products.`);
            return cart;
        });
    }
    decrease(userId: string, productId: string) {
        return this.run(async collection => {
            const path = `items.${productId}`;
            const cart = await collection.findOneAndUpdate({ _id: userId, [path]: { $gte: 1 } }, [
                { $set: { [path]: { $cond: [{ $eq: [`$${path}`, 1] }, '$$REMOVE', { $subtract: [`$${path}`, 1] }] }, updatedAt: '$$NOW', revision: { $add: [{ $ifNull: ['$revision', 0] }, 1] } } },
            ], { returnDocument: 'after' });
            if (!cart) throw new NotFoundException('This product is not in your cart');
            return cart;
        });
    }
    async remove(userId: string, productId: string) {
        await this.run(collection => collection.updateOne({ _id: userId }, {
            $unset: { [`items.${productId}`]: '' }, $inc: { revision: 1 }, $set: { updatedAt: new Date() },
        }));
    }
    async clearPurchasedIfUnchanged(userId: string, items: { productId: string }[], revision: number) {
        return this.run(async collection => {
            const result = await collection.updateOne({ _id: userId, $expr: { $eq: [{ $ifNull: ['$revision', 0] }, revision] } }, {
                $unset: Object.fromEntries(items.map(item => [`items.${item.productId}`, ''])),
                $inc: { revision: 1 }, $set: { updatedAt: new Date() },
            });
            return result.modifiedCount > 0;
        });
    }
    async onModuleDestroy() { await this.client?.close(); }
}
