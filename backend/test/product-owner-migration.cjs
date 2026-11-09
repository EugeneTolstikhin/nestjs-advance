const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const Database = require('better-sqlite3');
const { assignOwners } = require('../scripts/assign-product-owners.cjs');
const a = '550e8400-e29b-41d4-a716-446655440000';
const b = '550e8400-e29b-41d4-a716-446655440001';
const seller = '550e8400-e29b-41d4-a716-446655440002';
const other = '550e8400-e29b-41d4-a716-446655440003';
function legacy() {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE products (id varchar PRIMARY KEY, name varchar NOT NULL)');
    const insert = db.prepare('INSERT INTO products VALUES (?, ?)');
    insert.run(a, 'Old book'); insert.run(b, 'Old bag');
    db.exec(readFileSync('migrations/002-product-seller.sql', 'utf8'));
    return db;
}
test('SQL upgrade preserves products with unassigned ownership and indexes seller lookups', () => {
    const db = legacy();
    try {
        assert.deepEqual(db.prepare('SELECT name, sellerId FROM products ORDER BY id').all(), [
            { name: 'Old book', sellerId: null }, { name: 'Old bag', sellerId: null },
        ]);
        assert.ok(db.prepare('PRAGMA index_list(products)').all().some(index => index.name === 'IDX_products_sellerId'));
    } finally { db.close(); }
});
test('explicit assignments require real sellers and are safe to repeat', async () => {
    const db = legacy();
    try {
        const find = async ids => { assert.deepEqual(ids, [seller]); return [{ _id: seller, roles: ['buyer', 'seller'] }]; };
        assert.equal(await assignOwners(db, { [a]: seller }, find), 1);
        assert.equal(await assignOwners(db, { [a]: seller }, find), 0);
        assert.equal(db.prepare('SELECT sellerId FROM products WHERE id = ?').get(b).sellerId, null);
    } finally { db.close(); }
});
test('missing accounts, buyer-only accounts and malformed mappings never change ownership', async () => {
    const db = legacy();
    try {
        for (const accounts of [[], [{ _id: seller, roles: ['buyer'] }]]) {
            await assert.rejects(assignOwners(db, { [a]: seller }, async () => accounts), /seller role/);
        }
        for (const mapping of [{}, [], { [a]: 'bad-id' }]) await assert.rejects(assignOwners(db, mapping, async () => []));
        assert.equal(db.prepare('SELECT COUNT(*) AS count FROM products WHERE sellerId IS NOT NULL').get().count, 0);
    } finally { db.close(); }
});
test('a conflicting owner rolls back the whole mapping rather than partially reassigning products', async () => {
    const db = legacy();
    try {
        db.prepare('UPDATE products SET sellerId = ? WHERE id = ?').run(other, b);
        await assert.rejects(assignOwners(db, { [a]: seller, [b]: seller }, async () => [{ _id: seller, roles: ['seller'] }]), /Refusing to replace/);
        assert.equal(db.prepare('SELECT sellerId FROM products WHERE id = ?').get(a).sellerId, null);
        assert.equal(db.prepare('SELECT sellerId FROM products WHERE id = ?').get(b).sellerId, other);
    } finally { db.close(); }
});
