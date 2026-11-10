(() => {
  const root = document.getElementById('checkout-page');
  if (!root) return;
  interface Line {
    productId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }
  interface Reservation {
    id: string;
    status: 'reserved' | 'cancelled' | 'expired';
    expiresAt: number;
    revision: number;
    items: Line[];
    subtotalCents: number;
    serverNow: number;
  }
  interface Preview {
    serverNow: number;
    quote: {
      quoteHash: string;
      canReserve: boolean;
      items: Line[];
      subtotalCents: number;
      issues: { message: string }[];
    };
    checkout: Reservation | null;
  }
  const status = document.getElementById('checkout-status')!;
  const issues = document.getElementById('checkout-issues')!;
  const summary = document.getElementById('checkout-summary')!;
  const list = document.getElementById('checkout-items')!;
  const total = document.getElementById('checkout-total')!;
  const panel = document.getElementById('checkout-reservation')!;
  const reserve = document.getElementById(
    'checkout-reserve',
  ) as HTMLButtonElement;
  const release = document.getElementById(
    'checkout-release',
  ) as HTMLButtonElement;
  const refreshButton = document.getElementById(
    'checkout-refresh',
  ) as HTMLButtonElement;
  let current: Preview | undefined,
    busy = false,
    version = 0,
    stopped = false,
    offset = 0,
    expiryChecked = false;
  const money = (cents: number) =>
    new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: 'EUR',
    }).format(cents / 100);
  function message(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('form-error', error);
  }
  async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
    });
    const data = await response.json();
    if (response.status === 401 || response.status === 403) {
      current = undefined;
      summary.hidden = panel.hidden = issues.hidden = true;
      list.replaceChildren();
      throw new Error(
        response.status === 401
          ? 'Your session expired. Log in again to continue checkout.'
          : 'Checkout is available to buyer accounts.',
      );
    }
    if (!response.ok)
      throw Object.assign(
        new Error(
          Array.isArray(data.message)
            ? data.message.join(' · ')
            : data.message ||
                'Checkout could not be updated. Please try again.',
        ),
        { status: response.status },
      );
    return data;
  }
  function draw(data: Preview) {
    current = data;
    offset = data.serverNow - Date.now();
    expiryChecked = false;
    const active = data.checkout?.status === 'reserved' ? data.checkout : null;
    const lines = active?.items ?? data.quote.items;
    const nodes = lines.map((item) => {
      const row = document.createElement('li');
      const name = document.createElement('strong');
      name.textContent = item.name;
      const detail = document.createElement('span');
      detail.textContent = `${item.quantity} × ${money(item.unitPriceCents)} = ${money(item.lineTotalCents)}`;
      row.append(name, detail);
      return row;
    });
    list.replaceChildren(...nodes);
    summary.hidden = !lines.length;
    total.textContent = money(
      active?.subtotalCents ?? data.quote.subtotalCents,
    );
    issues.replaceChildren(
      ...(active ? [] : data.quote.issues).map((issue) => {
        const node = document.createElement('li');
        node.textContent = issue.message;
        return node;
      }),
    );
    issues.hidden = active !== null || !data.quote.issues.length;
    reserve.hidden = !!active || !data.quote.canReserve;
    panel.hidden = !active;
    document
      .getElementById('checkout-review-step')!
      .toggleAttribute('aria-current', !active);
    if (!active)
      document
        .getElementById('checkout-review-step')!
        .setAttribute('aria-current', 'step');
    document
      .getElementById('checkout-reserve-step')!
      .removeAttribute('aria-current');
    if (active)
      document
        .getElementById('checkout-reserve-step')!
        .setAttribute('aria-current', 'step');
    message(
      active
        ? 'Your reservation is saved. No payment has been taken.'
        : data.quote.canReserve
          ? 'Review the items and subtotal before reserving.'
          : 'Update your cart before continuing.',
      !active && !data.quote.canReserve,
    );
    tick();
  }
  function tick() {
    const active = current?.checkout;
    if (active?.status !== 'reserved') return;
    const seconds = Math.max(
      0,
      Math.ceil((active.expiresAt - Date.now() - offset) / 1000),
    );
    document.getElementById('checkout-countdown')!.textContent = seconds
      ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      : 'Checking availability…';
    if (!seconds && !busy && !expiryChecked) {
      expiryChecked = true;
      void refresh();
    }
  }
  async function refresh() {
    if (busy || stopped || document.hidden) return;
    const ticket = ++version;
    try {
      const data = await api<Preview>('/checkout/data');
      if (ticket === version && !stopped) {
        const previous = current?.checkout;
        draw(data);
        if (previous?.status === 'reserved' && !data.checkout)
          message(
            'Your reservation expired or was released on another device. Review availability before reserving again.',
          );
      }
    } catch (error) {
      if (ticket === version && !stopped)
        message(
          error instanceof Error
            ? error.message
            : 'Could not refresh checkout.',
          true,
        );
    }
  }
  async function mutate(cancel: boolean) {
    if (busy || !current || (cancel && !current.checkout)) return;
    busy = true;
    ++version;
    root!.setAttribute('aria-busy', 'true');
    reserve.disabled = release.disabled = refreshButton.disabled = true;
    const old = current;
    let conflict: string | undefined;
    let failure: string | undefined;
    let releaseNotice: string | undefined;
    try {
      const result = await api<Reservation>(
        cancel ? `/checkout/${old.checkout!.id}` : '/checkout/reservations',
        {
          method: cancel ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            cancel
              ? { revision: old.checkout!.revision }
              : { quoteHash: old.quote.quoteHash },
          ),
        },
      );
      if (stopped) return;
      if (!cancel) {
        draw({ ...old, serverNow: result.serverNow, checkout: result });
        message(
          'Items reserved for 15 minutes. Your cart has not been cleared.',
        );
        document.getElementById('checkout-reservation-title')?.focus();
      } else {
        releaseNotice =
          result.status === 'expired'
            ? 'Your reservation expired. Your cart is unchanged.'
            : 'Reservation released. Your cart is unchanged.';
        current = { ...old, checkout: null };
        panel.hidden = true;
        message('Reservation released. Your cart is unchanged.');
      }
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : 'Could not update checkout.';
      failure = detail;
      message(detail, true);
      if (
        error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 409
      )
        conflict = detail;
    } finally {
      busy = false;
      root!.removeAttribute('aria-busy');
      reserve.disabled = release.disabled = refreshButton.disabled = false;
    }
    if (cancel || conflict) await refresh();
    if (failure) message(failure, true);
    else if (releaseNotice) {
      message(releaseNotice);
      if (!issues.hidden) issues.focus();
      else document.getElementById('checkout-summary-title')?.focus();
    }
  }
  reserve.addEventListener('click', () => {
    void mutate(false);
  });
  release.addEventListener('click', () => {
    void mutate(true);
  });
  refreshButton.addEventListener('click', () => {
    void refresh();
  });
  window.addEventListener('focus', () => {
    void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  const timer = setInterval(tick, 1000),
    poll = setInterval(() => {
      void refresh();
    }, 15_000);
  window.addEventListener('pagehide', () => {
    stopped = true;
    ++version;
    clearInterval(timer);
    clearInterval(poll);
    current = undefined;
    list.replaceChildren();
    summary.hidden = panel.hidden = issues.hidden = true;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });
  void refresh();
})();
