const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { parseArgs } = require('node:util');
const Database = require('better-sqlite3');
const { MongoClient } = require('mongodb');

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

// Only explicit, verified assignments are allowed. Never guess from the current
// session, media ownership, or whichever seller happens to edit a legacy row.
async function assignOwners(db, mapping, findSellers) {
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Expected a product-ID to seller-ID JSON object');
    const entries = Object.entries(mapping);
    if (!entries.length || entries.some(([id, seller]) => !uuid.test(id) || typeof seller !== 'string' || !uuid.test(seller))) {
        throw new Error('Every product and seller ID must be a UUID v4');
    }
    const sellerIds = [...new Set(entries.map(([, seller]) => seller))];
    const accounts = await findSellers(sellerIds);
    const sellers = new Set(accounts.filter(account => {
        const roles = account.roles === undefined ? [account.typeOfUser] : account.roles;
        return Array.isArray(roles) && roles.includes('seller');
    }).map(account => account._id));
    if (sellerIds.some(id => !sellers.has(id))) throw new Error('Every assigned owner must be an existing MongoDB account with the seller role');
    return db.transaction(() => {
        const get = db.prepare('SELECT sellerId FROM products WHERE id = ?');
        const update = db.prepare('UPDATE products SET sellerId = ? WHERE id = ? AND sellerId IS NULL');
        let changed = 0;
        for (const [id, seller] of entries) {
            const product = get.get(id);
            if (!product) throw new Error(`Product not found: ${id}`);
            if (product.sellerId === seller) continue; // Re-running the same mapping is safe.
            if (product.sellerId !== null) throw new Error(`Refusing to replace the existing owner of ${id}`);
            if (update.run(seller, id).changes !== 1) throw new Error(`Ownership changed concurrently for ${id}`);
            changed++;
        }
        return changed;
    })();
}

async function main() {
    const envFile = resolve(__dirname, '../.env');
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const { values } = parseArgs({ options: { list: { type: 'boolean' }, assign: { type: 'string' }, database: { type: 'string' } } });
    if (!!values.list === !!values.assign) throw new Error('Use --list OR --assign mapping.json, optionally --database path.sqlite');
    const db = new Database(values.database ?? resolve(__dirname, '../database.sqlite'), { fileMustExist: true, readonly: !!values.list });
    let mongo;
    try {
        if (!db.prepare('PRAGMA table_info(products)').all().some(column => column.name === 'sellerId')) {
            throw new Error('Apply the product seller schema migration before assigning owners');
        }
        if (values.list) {
            console.log(JSON.stringify(db.prepare('SELECT id, name FROM products WHERE sellerId IS NULL ORDER BY name').all(), null, 2));
            return;
        }
        const mapping = JSON.parse(readFileSync(values.assign, 'utf8'));
        mongo = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017', { serverSelectionTimeoutMS: 5000 });
        await mongo.connect();
        const users = mongo.db(process.env.MONGODB_DATABASE ?? 'nestjs_advance').collection('users');
        const count = await assignOwners(db, mapping, ids => users.find({ _id: { $in: ids } }, { projection: { _id: 1, roles: 1, typeOfUser: 1 } }).toArray());
        console.log(`Assigned ${count} product owners.`);
    } finally {
        db.close();
        await mongo?.close();
    }
}
if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { assignOwners };
