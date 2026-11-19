(() => {
  const root = document.getElementById('order-confirmation');
  if (!root) return;
  const id = root.dataset.checkoutId!;
  const status = document.getElementById('order-status')!;
  const sellers = document.getElementById('order-sellers')!;
  interface Data {
    id: string;
    orderId: string;
    orderNumber?: string;
    placedAt?: number;
    totalCents: number;
    currency: string;
    recipient: string | null;
    preparing: boolean;
    emailConfigured: boolean;
    sellers: {
      id: string;
      totalCents: number;
      sellerName?: string;
      canReturn?: boolean;
      items: {
        name: string;
        quantity: number;
        lineTotalCents: number;
        thumbnail?: string | null;
      }[];
      invoice: { number: string; status: string } | null;
      shipment: {
        trackingNumber: string | null;
        status: string;
        events: { sequence: number; status: string; occurredAt: number }[];
      } | null;
      notifications: {
        status: string;
        kind: string;
        event: { status: string; occurredAt: number };
      }[];
    }[];
  }
  let stopped = false,
    loading = false,
    signature = '';
  const money = (value: number) =>
    new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: 'EUR',
    }).format(value / 100);
  function node(tag: string, text: string, className?: string) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  async function refresh() {
    if (stopped || loading || document.hidden) return;
    loading = true;
    try {
      const response = await fetch(`/orders/${id}/data`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        sellers.replaceChildren();
        document.getElementById('order-reference')!.textContent = '';
        document.getElementById('order-total')!.textContent = '';
        signature = '';
        throw new Error(
          'Log in with the account that placed this order to see its confirmation.',
        );
      }
      if (!response.ok)
        throw new Error('Unable to refresh the order. Please try again.');
      const data: Data = await response.json();
      if (stopped) return;
      document.getElementById('order-reference')!.textContent =
        `Order #${data.orderNumber ?? data.orderId.slice(0, 8).toUpperCase()}${data.placedAt ? ` · Placed ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(data.placedAt)}` : ''}`;
      document.getElementById('order-total')!.textContent =
        `Paid total: ${money(data.totalCents)}`;
      const text = data.preparing
        ? 'Preparing your invoices and tracking numbers…'
        : data.recipient
          ? `Order emails will be ${data.emailConfigured ? 'sent' : 'handled by the development LOG adapter'} to your verified account email: ${data.recipient}.`
          : 'No verified account email is available. Download and print invoices here; email notifications are skipped.';
      if (status.textContent !== text) status.textContent = text;
      const next = JSON.stringify(data.sellers);
      if (signature === next) return;
      signature = next;
      sellers.replaceChildren(
        ...data.sellers.map((seller, index) => {
          const section = node('section', '', 'checkout-panel');
          section.append(
            node(
              'h2',
              seller.sellerName
                ? `Sold by ${seller.sellerName}`
                : `Delivery ${index + 1}`,
            ),
          );
          const list = document.createElement('ul');
          list.className = 'order-products';
          seller.items.forEach((item) => {
            const row = node('li', '', 'order-product');
            const photo = node('div', '', 'order-thumbnail');
            photo.append(node('span', 'Photo unavailable'));
            if (item.thumbnail) {
              const image = document.createElement('img');
              image.src = item.thumbnail;
              image.alt = item.name;
              image.loading = 'lazy';
              image.setAttribute('data-order-image', '');
              photo.append(image);
            }
            const text = node('div', '');
            text.append(
              node('h3', item.name),
              node(
                'p',
                `Quantity ${item.quantity} · ${money(item.lineTotalCents)}`,
              ),
            );
            row.append(photo, text);
            list.append(row);
          });
          section.append(
            list,
            node(
              'p',
              `Seller total including shipping: ${money(seller.totalCents)}`,
            ),
          );
          if (seller.canReturn) {
            const action = document.createElement('a');
            action.className = 'nav-button nav-button-secondary';
            action.href = `/returns?checkout=${id}&seller=${seller.id}`;
            action.textContent = 'Return items';
            section.append(action);
          }
          section.append(node('h3', 'Invoice'));
          if (seller.invoice?.status === 'ready') {
            section.append(
              node(
                'p',
                `${seller.invoice.number} · Development demo, not a tax invoice`,
              ),
            );
            const actions = node('div', '', 'product-actions');
            for (const [title, query] of [
              ['Download PDF', ''],
              ['Open PDF to print', '?inline=1'],
            ]) {
              const link = document.createElement('a');
              link.className = 'nav-button nav-button-secondary';
              link.textContent = title;
              link.href = `/orders/${id}/invoices/${seller.id}${query}`;
              if (query) {
                link.target = '_blank';
                link.rel = 'noopener';
              }
              actions.append(link);
            }
            section.append(actions);
          } else
            section.append(node('p', 'Your PDF invoice is being prepared.'));
          section.append(node('h3', 'Delivery tracking'));
          if (seller.shipment?.trackingNumber) {
            section.append(
              node('p', `Tracking number: ${seller.shipment.trackingNumber}`),
              node(
                'p',
                `Status: ${seller.shipment.status.replaceAll('_', ' ')}`,
              ),
            );
            const events = document.createElement('ol');
            seller.shipment.events.forEach((event) =>
              events.append(
                node(
                  'li',
                  `${event.status.replaceAll('_', ' ')} · ${new Date(event.occurredAt).toLocaleString()}`,
                ),
              ),
            );
            section.append(events);
          } else
            section.append(
              node('p', 'Creating your delivery tracking number…'),
            );
          const messages = document.createElement('ul');
          seller.notifications.forEach((notice) =>
            messages.append(
              node(
                'li',
                `${notice.kind === 'confirmation' ? 'Invoice email' : `${notice.event.status.replaceAll('_', ' ')} email`}: ${notice.status === 'pending' ? 'queued / retrying' : notice.status}`,
              ),
            ),
          );
          section.append(messages);
          return section;
        }),
      );
    } catch (error) {
      if (!stopped)
        status.textContent =
          error instanceof Error
            ? error.message
            : 'Unable to load confirmation.';
    } finally {
      loading = false;
    }
  }
  const timer = setInterval(() => {
    void refresh();
  }, 5000);
  window.addEventListener('focus', () => {
    void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearInterval(timer);
    sellers.replaceChildren();
    document.getElementById('order-reference')!.textContent = '';
    document.getElementById('order-total')!.textContent = '';
    status.textContent = '';
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });
  void refresh();
})();
