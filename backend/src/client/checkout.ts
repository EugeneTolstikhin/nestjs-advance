(() => {
  const root = document.getElementById('checkout-page');
  if (!root) return;
  interface Line {
    productId: string;
    sellerId?: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
  }
  interface Delivery {
    fullName: string;
    email?: string;
    phone?: string;
    addressLine1: string;
    addressLine2?: string;
    postalCode: string;
    city: string;
    country: string;
  }
  interface Shipping {
    method: string;
    label: string;
    estimatedDelivery: string;
    shipments: { sellerId: string; feeCents: number }[];
    shippingCents: number;
  }
  interface Reservation {
    id: string;
    status: 'reserved' | 'cancelled' | 'expired' | 'completed';
    expiresAt: number;
    revision: number;
    items: Line[];
    subtotalCents: number;
    serverNow: number;
    step?: string;
    delivery?: Delivery | null;
    shipping?: Shipping | null;
    shippingOptions?: Shipping[];
    totalCents?: number | null;
    payment?: {
      id: string;
      status: string;
      paymentUrl: string | null;
      cancelRequested: boolean;
      lastFailure?: 'provider' | 'finalization' | null;
      retryCheckoutId?: string;
      optionId?: string;
      optionLabel?: string;
      simulated?: boolean;
    } | null;
    order?: { id: string; status: string; cleanup: string } | null;
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
  let selectedSession = new URLSearchParams(window.location.search).get(
    'session',
  );
  if (selectedSession && !/^[a-f0-9-]{36}$/i.test(selectedSession))
    selectedSession = null;
  const paymentPanel = document.getElementById('checkout-payment');
  const payButton = document.getElementById(
    'checkout-pay',
  ) as HTMLButtonElement | null;
  const retryButton = document.getElementById(
    'checkout-retry',
  ) as HTMLButtonElement | null;

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
      clearDetails();
      clearPayment();
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
    const paymentSession = data.checkout?.payment ? data.checkout : null;
    if (paymentSession && selectedSession !== paymentSession.id) {
      selectedSession = paymentSession.id;
      window.history.replaceState(
        null,
        '',
        `/checkout?session=${paymentSession.id}`,
      );
    }
    const lines = paymentSession?.items ?? active?.items ?? data.quote.items;
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
      paymentSession?.subtotalCents ??
        active?.subtotalCents ??
        data.quote.subtotalCents,
    );
    issues.replaceChildren(
      ...(active ? [] : data.quote.issues).map((issue) => {
        const node = document.createElement('li');
        node.textContent = issue.message;
        return node;
      }),
    );
    issues.hidden = active !== null || !data.quote.issues.length;
    reserve.hidden = !!active || !!paymentSession || !data.quote.canReserve;
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
    if (!detailsDirty)
      message(
        active
          ? 'Your reservation is saved. No payment has been taken.'
          : data.quote.canReserve
            ? 'Review the items and subtotal before reserving.'
            : 'Update your cart before continuing.',
        !active && !data.quote.canReserve,
      );
    drawDetails(active);
    drawPayment(paymentSession);
    release.textContent = active?.payment
      ? active.payment.simulated === false
        ? 'Cancel payment'
        : 'Cancel test payment'
      : 'Release reservation';
    release.disabled = busy || !!active?.payment?.cancelRequested;
    tick();
  }
  const deliveryForm = document.getElementById(
    'checkout-delivery-form',
  ) as HTMLFormElement | null;
  const shippingForm = document.getElementById(
    'checkout-shipping-form',
  ) as HTMLFormElement | null;
  let renderedDetails = '';
  let detailsDirty = false;
  function clearDetails() {
    deliveryForm?.reset();
    shippingForm?.reset();
    for (const id of [
      'checkout-delivery',
      'checkout-shipping',
      'checkout-final-review',
    ]) {
      const node = document.getElementById(id);
      if (node) node.hidden = true;
    }
    for (const id of [
      'checkout-delivery-summary',
      'checkout-shipping-summary',
      'checkout-shipping-options',
      'checkout-review-subtotal',
      'checkout-review-shipping',
      'checkout-review-total',
      'checkout-shipment-review',
    ])
      document.getElementById(id)?.replaceChildren();
    renderedDetails = '';
    detailsDirty = false;
  }
  function drawDetails(active: Reservation | null) {
    const step = active?.step ?? 'delivery';
    for (const [id, value] of [
      ['checkout-delivery', 'delivery'],
      ['checkout-shipping', 'shipping'],
      ['checkout-final-review', 'review'],
    ]) {
      const node = document.getElementById(id);
      if (node) node.hidden = !active || step !== value;
    }
    for (const [id, value] of [
      ['checkout-delivery-step', 'delivery'],
      ['checkout-shipping-step', 'shipping'],
      ['checkout-final-review-step', 'review'],
    ]) {
      const node = document.getElementById(id);
      node?.removeAttribute('aria-current');
      if (active && step === value) node?.setAttribute('aria-current', 'step');
    }
    if (active && document.getElementById('checkout-delivery-step'))
      document
        .getElementById('checkout-reserve-step')
        ?.removeAttribute('aria-current');
    if (!active) {
      clearDetails();
      return;
    }
    // Polling must never overwrite a partially typed address or reset keyboard focus.
    const key = `${active.id}:${active.revision}:${step}`;
    if (renderedDetails === key) return;
    if (detailsDirty && renderedDetails && renderedDetails !== key) {
      detailsDirty = false;
      message(
        'Checkout changed on another device. The latest saved details are shown; review them before continuing.',
      );
    }
    renderedDetails = key;
    if (deliveryForm) {
      deliveryForm.reset();
      (
        deliveryForm.elements.namedItem('email') as HTMLInputElement
      )?.setCustomValidity('');
      for (const [name, value] of Object.entries(active.delivery ?? {})) {
        const input = deliveryForm.elements.namedItem(name);
        if (
          input instanceof HTMLInputElement ||
          input instanceof HTMLSelectElement
        )
          input.value = value;
      }
    }
    const options = document.getElementById('checkout-shipping-options');
    options?.replaceChildren(
      ...(active.shippingOptions ?? []).map((option) => {
        const label = document.createElement('label');
        label.className = 'checkout-shipping-option';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'method';
        input.value = option.method;
        input.required = true;
        input.checked = active.shipping?.method === option.method;
        const text = document.createElement('span');
        text.textContent = `${option.label} · ${money(option.shippingCents)} for ${option.shipments.length} shipment(s) · ${option.estimatedDelivery}`;
        label.append(input, text);
        return label;
      }),
    );
    const delivery = active.delivery;
    const address = document.getElementById('checkout-delivery-summary');
    if (address)
      address.textContent = delivery
        ? [
            delivery.fullName,
            delivery.addressLine1,
            delivery.addressLine2,
            `${delivery.postalCode} ${delivery.city}`,
            'Germany',
            delivery.email,
            delivery.phone,
          ]
            .filter(Boolean)
            .join('\n')
        : '';
    const shipping = document.getElementById('checkout-shipping-summary');
    if (shipping)
      shipping.textContent = active.shipping
        ? `${active.shipping.label} · ${active.shipping.shipments.length} separate seller shipment(s) · ${active.shipping.estimatedDelivery}`
        : '';
    document.getElementById('checkout-shipment-review')?.replaceChildren(
      ...(active.shipping?.shipments ?? []).map((shipment, index) => {
        const item = document.createElement('li');
        const names = active.items
          .filter((line) => line.sellerId === shipment.sellerId)
          .map((line) => line.name)
          .join(', ');
        item.textContent = `Shipment ${index + 1}: ${names || 'Seller items'} · ${money(shipment.feeCents)}`;
        return item;
      }),
    );
    for (const [id, amount] of [
      ['checkout-review-subtotal', active.subtotalCents],
      ['checkout-review-shipping', active.shipping?.shippingCents],
      ['checkout-review-total', active.totalCents],
    ] as const) {
      const node = document.getElementById(id);
      if (node)
        node.textContent = amount == null ? 'Not selected' : money(amount);
    }
  }
  function detailsBusy(value: boolean) {
    for (const form of [deliveryForm, shippingForm])
      form
        ?.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLButtonElement
        >('input, select, button')
        .forEach((node) => {
          node.disabled = value;
        });
    reserve.disabled = release.disabled = refreshButton.disabled = value;
    if (retryButton) retryButton.disabled = value;
  }
  async function saveDetails(
    action: 'delivery' | 'shipping' | 'back',
    values: Record<string, unknown> = {},
  ) {
    const old = current,
      session = old?.checkout;
    if (!old || !session || busy || stopped) return;
    busy = true;
    ++version;
    detailsBusy(true);
    root!.setAttribute('aria-busy', 'true');
    let conflict = false;
    let failure: string | undefined;
    try {
      const result = await api<Reservation>(
        `/checkout/${session.id}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...values, revision: session.revision }),
        },
      );
      if (stopped) return;
      detailsDirty = false;
      draw({ ...old, serverNow: result.serverNow, checkout: result });
      message(
        action === 'back'
          ? 'Returned to the previous step.'
          : 'Checkout details saved.',
      );
      document
        .getElementById(
          result.step === 'review'
            ? 'checkout-final-review-title'
            : `checkout-${result.step}-title`,
        )
        ?.focus();
    } catch (error) {
      failure =
        error instanceof Error
          ? error.message
          : 'Could not save checkout details.';
      conflict =
        !!error &&
        typeof error === 'object' &&
        'status' in error &&
        error.status === 409;
    } finally {
      busy = false;
      detailsBusy(false);
      root!.removeAttribute('aria-busy');
    }
    if (conflict) await refresh();
    if (failure && !stopped) message(failure, true);
  }
  function validateContact() {
    const email = deliveryForm?.elements.namedItem(
      'email',
    ) as HTMLInputElement | null;
    const phone = deliveryForm?.elements.namedItem(
      'phone',
    ) as HTMLInputElement | null;
    email?.setCustomValidity(
      email.value.trim() || phone?.value.trim()
        ? ''
        : 'Provide an email or phone number for order updates.',
    );
  }
  deliveryForm?.addEventListener('input', () => {
    detailsDirty = true;
    validateContact();
  });
  deliveryForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    validateContact();
    if (!deliveryForm.reportValidity()) return;
    const data = Object.fromEntries(new FormData(deliveryForm).entries());
    for (const key of Object.keys(data)) {
      if (typeof data[key] === 'string') data[key] = data[key].trim();
      if (!data[key] && ['email', 'phone', 'addressLine2'].includes(key))
        delete data[key];
    }
    void saveDetails('delivery', data);
  });
  shippingForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!shippingForm.reportValidity()) return;
    void saveDetails('shipping', {
      method: new FormData(shippingForm).get('method'),
    });
  });
  root.querySelectorAll('[data-checkout-back]').forEach((button) =>
    button.addEventListener('click', () => {
      void saveDetails('back');
    }),
  );
  function clearPayment() {
    if (paymentPanel) paymentPanel.hidden = true;
    if (retryButton) retryButton.hidden = true;
    const retryNote = document.getElementById('checkout-retry-note');
    if (retryNote) retryNote.hidden = true;
    document.getElementById('checkout-payment-status')?.replaceChildren();
    document.getElementById('checkout-order-reference')?.replaceChildren();
    document.getElementById('checkout-payment-method')?.replaceChildren();
    document.getElementById('checkout-payment-note')?.replaceChildren();
    const link = document.getElementById('checkout-provider-link');
    link?.removeAttribute('href');
    if (link) link.hidden = true;
  }
  function drawPayment(session: Reservation | null) {
    if (!paymentPanel) return;
    paymentPanel.hidden = !session;
    const link = document.getElementById(
      'checkout-provider-link',
    ) as HTMLAnchorElement;
    if (!session?.payment) {
      clearPayment();
      return;
    }
    const payment = session.payment;
    const canRetry =
      !!payButton &&
      ['failed', 'cancelled', 'expired'].includes(payment.status) &&
      ['cancelled', 'expired'].includes(session.status);
    if (retryButton) {
      retryButton.hidden = !canRetry;
      retryButton.disabled = busy;
      retryButton.textContent = payment.retryCheckoutId
        ? 'Resume replacement checkout'
        : 'Try another payment method';
    }
    const retryNote = document.getElementById('checkout-retry-note');
    if (retryNote) {
      retryNote.hidden = !canRetry;
      retryNote.textContent = payment.retryCheckoutId
        ? 'A replacement checkout already exists. Resume it to see its latest status.'
        : 'We’ll recheck your cart and reserve available items again. Your delivery details are kept; review the latest total and choose a payment method before paying.';
    }
    const methodLabel = document.getElementById('checkout-payment-method');
    if (methodLabel)
      methodLabel.textContent = `${payment.optionLabel ?? 'Payment'}${payment.simulated !== false ? ' (simulated)' : ''}`;
    const simulated = payment.simulated !== false;
    const prefix = simulated ? 'Test payment' : 'Payment';
    const note = document.getElementById('checkout-payment-note');
    if (note)
      note.textContent = `${simulated ? 'No real money is charged. ' : ''}The shop checks the provider directly; returning here does not prove payment.`;
    const text =
      payment.status === 'succeeded'
        ? `${prefix} confirmed. Your order is complete and stock has been updated. Delivery has not started.`
        : payment.cancelRequested &&
            ['pending', 'unknown'].includes(payment.status)
          ? 'Cancellation requested. Waiting for the provider to confirm whether payment was cancelled or already completed.'
          : payment.status === 'unknown'
            ? payment.lastFailure === 'finalization'
              ? 'The shop is retrying payment verification and order finalization. Your stock stays reserved; do not start another payment.'
              : 'The provider result is uncertain. We are checking again. Your reserved stock stays protected; do not start another payment.'
            : payment.status === 'pending'
              ? payment.paymentUrl
                ? simulated
                  ? 'Awaiting your test payment. Open the provider below, choose an outcome, then return here.'
                  : 'Awaiting payment. Continue with your selected provider, then return here.'
                : 'Preparing your payment with the provider…'
              : `${prefix} ${payment.status}. No order was paid. You can try another payment method below.`;
    document.getElementById('checkout-payment-status')!.textContent = text;
    document.getElementById('checkout-order-reference')!.textContent =
      session.order ? `Order reference: ${session.order.id}` : '';
    link.hidden =
      !payment.paymentUrl ||
      payment.status !== 'pending' ||
      payment.cancelRequested;
    if (!link.hidden) link.href = payment.paymentUrl!;
    else link.removeAttribute('href');
    message(
      payment.status === 'succeeded'
        ? simulated
          ? 'Order completed (simulated payment).'
          : 'Order completed.'
        : text,
      !['pending', 'succeeded'].includes(payment.status),
    );
  }
  payButton?.addEventListener('click', async () => {
    if (busy || !current?.checkout || current.checkout.step !== 'review')
      return;
    const choice = root!.querySelector<HTMLInputElement>(
      'input[name="paymentOption"]:checked',
    );
    if (!choice) {
      message('Choose a payment method before continuing.', true);
      root!
        .querySelector<HTMLInputElement>('input[name="paymentOption"]')
        ?.focus();
      return;
    }
    const old = current;
    busy = true;
    ++version;
    detailsBusy(true);
    payButton.disabled = true;
    try {
      const result = await api<Reservation>(
        `/checkout/${old.checkout!.id}/payment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            revision: old.checkout!.revision,
            optionId: choice.value,
          }),
        },
      );
      if (stopped) return;
      selectedSession = result.id;
      window.history.replaceState(null, '', `/checkout?session=${result.id}`);
      draw({ ...old, serverNow: result.serverNow, checkout: result });
      document.getElementById('checkout-payment-title')?.focus();
    } catch (error) {
      message(
        error instanceof Error ? error.message : 'Unable to start payment.',
        true,
      );
    } finally {
      busy = false;
      detailsBusy(false);
      payButton.disabled = false;
    }
  });
  retryButton?.addEventListener('click', async () => {
    const previous = current?.checkout;
    if (
      busy ||
      !previous?.payment ||
      !['failed', 'cancelled', 'expired'].includes(previous.payment.status)
    )
      return;
    busy = true;
    ++version;
    detailsBusy(true);
    root!.setAttribute('aria-busy', 'true');
    try {
      const resumeId = previous.payment.retryCheckoutId;
      const latest = resumeId ? current! : await api<Preview>('/checkout/data');
      if (!resumeId && !latest.quote.canReserve)
        throw new Error(
          latest.quote.issues.map((issue) => issue.message).join(' · ') ||
            'Your cart needs attention before retrying.',
        );
      const result = resumeId
        ? await api<Reservation>(`/checkout/${resumeId}`)
        : await api<Reservation>(`/checkout/${previous.id}/retry`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              revision: previous.revision,
              quoteHash: latest.quote.quoteHash,
            }),
          });
      if (stopped) return;
      detailsDirty = false;
      root!
        .querySelectorAll<HTMLInputElement>('input[name="paymentOption"]')
        .forEach((input) => {
          input.checked = false;
        });
      selectedSession = result.id;
      window.history.replaceState(null, '', `/checkout?session=${result.id}`);
      draw({ ...latest, serverNow: result.serverNow, checkout: result });
      message(
        result.payment
          ? 'Showing your replacement checkout.'
          : 'Items reserved again. Review the updated total and choose a payment method.',
      );
      document
        .getElementById(
          result.payment
            ? 'checkout-payment-title'
            : result.step === 'review'
              ? 'checkout-final-review-title'
              : `checkout-${result.step}-title`,
        )
        ?.focus();
    } catch (error) {
      if (!stopped)
        message(
          error instanceof Error
            ? error.message
            : 'Unable to prepare another payment.',
          true,
        );
    } finally {
      busy = false;
      detailsBusy(false);
      root!.removeAttribute('aria-busy');
    }
  });
  function tick() {
    const active = current?.checkout;
    if (active?.status !== 'reserved') return;
    if (
      active.payment &&
      ['pending', 'unknown'].includes(active.payment.status)
    ) {
      document.getElementById('checkout-countdown')!.textContent =
        'Held until the provider confirms the result';
      return;
    }
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
      let data: Preview;
      if (selectedSession) {
        const session = await api<Reservation>(`/checkout/${selectedSession}`);
        data = {
          serverNow: session.serverNow,
          checkout: session,
          quote: {
            quoteHash: '',
            canReserve: false,
            items: [],
            subtotalCents: 0,
            issues: [],
          },
        };
      } else data = await api<Preview>('/checkout/data');
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
    detailsBusy(true);
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
      } else if (result.status === 'reserved' && result.payment) {
        draw({ ...old, serverNow: result.serverNow, checkout: result });
      } else {
        selectedSession = null;
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
      detailsBusy(false);
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
    }, 2000);
  window.addEventListener('pagehide', () => {
    stopped = true;
    ++version;
    clearInterval(timer);
    clearInterval(poll);
    current = undefined;
    list.replaceChildren();
    clearDetails();
    clearPayment();
    summary.hidden = panel.hidden = issues.hidden = true;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  });
  void refresh();
})();
