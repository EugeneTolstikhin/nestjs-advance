import type { EntityManager } from 'typeorm';

// Deadline checks make expiration effective even if the server has been stopped.
// SQL parameters, not browser-supplied values, determine availability.
export async function reservedQuantities(
  manager: EntityManager,
  productIds: string[],
  now = Date.now(),
  exceptCheckout?: string,
  exceptBuyer?: string,
): Promise<Map<string, number>> {
  if (!productIds.length) return new Map();
  const rows: { productId: string; quantity: number }[] = await manager.query(
    `
    SELECT r.productId, SUM(r.quantity) AS quantity
    FROM stock_reservations r JOIN checkout_sessions c ON c.id = r.checkoutId
    WHERE c.status = 'reserved' AND (c.expiresAt > ? OR json_extract(c.payment, '$.status') IN ('pending', 'unknown'))
      AND r.productId IN (${productIds.map(() => '?').join(',')})
      ${exceptCheckout ? 'AND c.id <> ?' : ''}
      ${exceptBuyer ? 'AND c.buyerId <> ?' : ''}
    GROUP BY r.productId`,
    [
      now,
      ...productIds,
      ...(exceptCheckout ? [exceptCheckout] : []),
      ...(exceptBuyer ? [exceptBuyer] : []),
    ],
  );
  return new Map(rows.map((row) => [row.productId, Number(row.quantity)]));
}
