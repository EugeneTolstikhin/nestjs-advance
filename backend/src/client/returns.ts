(() => {
  const root = document.getElementById('returns-page');
  if (!root) return;
  const content = document.getElementById('returns-content')!;
  const status = document.getElementById('returns-status')!;
  const returnId = root.dataset.returnId;
  type Line = {
    productId: string;
    name: string;
    quantity: number;
    unitPriceCents: number;
    reason: string;
  };
  type Inspection = {
    productId: string;
    received: number;
    sellable: number;
    restock: number;
    refund: number;
  };
  interface ReturnView {
    id: string;
    checkoutId: string;
    sellerOrderId: string;
    kind: string;
    status: string;
    revision: number;
    canReview: boolean;
    items: Line[];
    history: { author: string; text: string; at: number }[];
    shipment: {
      trackingNumber: string;
      status: string;
      events: { status: string; occurredAt: number }[];
    } | null;
    inspection: {
      items: Inspection[];
      notes: string;
      discrepancy: boolean;
    } | null;
    buyerIssue: boolean;
    shippingCents: number;
    claim: {
      notes: string;
      result: { status: string; resolution: string } | null;
    } | null;
    evidence: { id: string; author: string; at: number }[];
    refund: { amountCents: number; status: string } | null;
  }
  interface OrderOption {
    checkoutId: string;
    orderId: string;
    sellerOrderId: string;
    items: (Line & { available: number })[];
  }
  let dirty = false,
    loading = false,
    stopped = false,
    busy = false,
    signature = '';
  const label = (value: string) => value.replaceAll('_', ' ');
  const money = (value: number) =>
    new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency: 'EUR',
    }).format(value / 100);
  function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    text = '',
    className?: string,
  ) {
    const item = document.createElement(tag);
    item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function link(text: string, href: string) {
    const item = element('a', text, 'nav-button nav-button-secondary');
    item.href = href;
    return item;
  }
  function button(text: string) {
    const item = element('button', text, 'nav-button nav-button-primary');
    item.type = 'submit';
    return item;
  }
  function field(title: string, input: HTMLElement) {
    const row = element('label', title);
    row.append(input);
    return row;
  }
  function number(title: string, value: number, max: number) {
    const input = element('input');
    input.type = 'number';
    input.min = '0';
    input.max = String(max);
    input.step = '1';
    input.value = String(value);
    input.required = true;
    return { input, row: field(title, input) };
  }
  async function api(path: string, options?: RequestInit) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
    });
    const data = await response.json();
    if ([401, 403, 404].includes(response.status)) {
      content.replaceChildren();
      signature = '';
    }
    if (!response.ok)
      throw new Error(
        typeof data.message === 'string'
          ? data.message
          : 'Please check the form and try again.',
      );
    return data;
  }
  async function submit(
    form: HTMLFormElement,
    operation: () => Promise<unknown>,
  ) {
    if (busy) return;
    busy = true;
    form.querySelectorAll('button').forEach((item) => (item.disabled = true));
    try {
      await operation();
      dirty = false;
      signature = '';
      await refresh();
      status.textContent = 'Return saved.';
    } catch (error) {
      status.textContent =
        error instanceof Error ? error.message : 'Unable to save return.';
    } finally {
      busy = false;
      form
        .querySelectorAll('button')
        .forEach((item) => (item.disabled = false));
    }
  }
  function actionForm(
    record: ReturnView,
    title: string,
    action: string,
    build?: (form: HTMLFormElement) => () => Record<string, unknown>,
  ) {
    const form = element('form');
    form.append(element('h3', title));
    const values = build?.(form);
    const notes = element('textarea');
    notes.maxLength = 3000;
    notes.required = !['approve'].includes(action);
    form.append(field('Explanation', notes), button(title));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submit(form, () =>
        api(`/returns/${record.id}/actions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            revision: record.revision,
            notes: notes.value,
            ...values?.(),
          }),
        }),
      );
    });
    return form;
  }
  function details(record: ReturnView) {
    const section = element('section');
    section.append(
      element(
        'h2',
        record.kind === 'failed_delivery'
          ? 'Undelivered shipment return'
          : 'Buyer-requested return',
      ),
      element('p', `Status: ${label(record.status)}`),
      element('p', `Reference: ${record.id}`),
      ...(record.canReview
        ? []
        : [link('Original order', `/orders/${record.checkoutId}`)]),
    );
    const lines = element('ul');
    record.items.forEach((item) =>
      lines.append(
        element(
          'li',
          `${item.name} · Expected ${item.quantity} · ${money(item.unitPriceCents)} each · ${item.reason}`,
        ),
      ),
    );
    section.append(lines);
    if (record.shipment) {
      section.append(
        element('h3', 'Return shipment'),
        element(
          'p',
          `${record.shipment.trackingNumber} · ${label(record.shipment.status)}`,
        ),
      );
      const events = element('ol');
      record.shipment.events.forEach((event) =>
        events.append(
          element(
            'li',
            `${label(event.status)} · ${new Date(event.occurredAt).toLocaleString()}`,
          ),
        ),
      );
      section.append(events);
    } else if (record.status === 'approved')
      section.append(
        element('p', 'Preparing return shipment and instructions…'),
      );
    if (record.status === 'awaiting_shipment')
      section.append(
        element(
          'p',
          'Pack the approved items securely and use the return tracking reference above. Carrier handover is controlled in the local delivery simulator.',
        ),
      );
    if (record.canReview && record.status === 'requested') {
      section.append(
        actionForm(record, 'Approve return', 'approve'),
        actionForm(record, 'Reject request', 'reject'),
      );
    }
    if (record.inspection) {
      section.append(
        element(
          'h3',
          record.inspection.discrepancy
            ? 'Inspection — discrepancy recorded'
            : 'Inspection',
        ),
      );
      const inspected = element('ul');
      record.inspection.items.forEach((item) =>
        inspected.append(
          element(
            'li',
            `${record.items.find((line) => line.productId === item.productId)?.name}: received ${item.received}, sellable ${item.sellable}, restock ${item.restock}, refund ${item.refund}`,
          ),
        ),
      );
      section.append(inspected, element('p', record.inspection.notes));
    }
    if (
      record.canReview &&
      ['received', 'under_review'].includes(record.status)
    ) {
      section.append(
        actionForm(record, 'Save inspection', 'inspect', (form) => {
          const inputs = record.items.map((item) => {
            const old = record.inspection?.items.find(
              (value) => value.productId === item.productId,
            );
            const row = element('div', '', 'return-line');
            row.append(
              element('h4', `${item.name} · Expected ${item.quantity}`),
            );
            const fields = element('div', '', 'return-quantities');
            const received = number(
              'Received',
              old?.received ?? item.quantity,
              999,
            );
            const sellable = number(
              'Sellable',
              old?.sellable ?? item.quantity,
              999,
            );
            const restock = number(
              'Add to stock',
              old?.restock ?? 0,
              item.quantity,
            );
            const refund = number(
              'Refund quantity',
              old?.refund ?? 0,
              item.quantity,
            );
            fields.append(received.row, sellable.row, restock.row, refund.row);
            row.append(fields);
            form.append(row);
            return () => ({
              productId: item.productId,
              received: Number(received.input.value),
              sellable: Number(sellable.input.value),
              restock: Number(restock.input.value),
              refund: Number(refund.input.value),
            });
          });
          form.append(
            element(
              'p',
              'Stock changes and approved item refunds are applied when you finalize the review.',
            ),
          );
          return () => ({ items: inputs.map((read) => read()) });
        }),
      );
      if (record.inspection) {
        section.append(
          actionForm(record, 'Ask buyer for clarification', 'ask_buyer'),
        );
        if (record.inspection.discrepancy || record.buyerIssue)
          section.append(
            actionForm(record, 'Record discrepancy resolution', 'close_issue'),
          );
        if (record.inspection.discrepancy && !record.claim)
          section.append(
            actionForm(record, 'Open carrier claim', 'carrier_claim'),
          );
        if (!record.buyerIssue)
          section.append(
            actionForm(
              record,
              'Finalize review and apply stock/refund',
              'resolve',
              (form) => {
                const shipping = number(
                  'Shipping refund (EUR)',
                  0,
                  record.shippingCents / 100,
                );
                shipping.input.step = '0.01';
                form.append(shipping.row);
                return () => ({
                  shippingRefundCents: Math.round(
                    Number(shipping.input.value) * 100,
                  ),
                });
              },
            ),
          );
      }
    }
    if (record.buyerIssue)
      section.append(
        element(
          'p',
          'Buyer clarification is requested. Use the message form to respond.',
        ),
      );
    if (record.claim)
      section.append(
        element('h3', 'Carrier claim'),
        element(
          'p',
          `${record.claim.result?.status ?? 'queued'} · ${record.claim.result?.resolution ?? record.claim.notes}`,
        ),
      );
    if (record.refund)
      section.append(
        element('h3', 'Refund'),
        element(
          'p',
          `${money(record.refund.amountCents)} · ${record.refund.status}`,
        ),
      );
    if (record.canReview && record.refund?.status === 'failed')
      section.append(
        actionForm(record, 'Retry reviewed refund', 'retry_refund'),
      );
    const history = element('ol');
    record.history.forEach((event) =>
      history.append(
        element(
          'li',
          `${new Date(event.at).toLocaleString()} · ${event.author}: ${event.text}`,
        ),
      ),
    );
    section.append(
      element('h3', 'Messages and activity'),
      history,
      actionForm(record, 'Send message', 'message'),
    );
    const photos = element('div', '', 'return-photos');
    record.evidence.forEach((photo) => {
      const url = `/returns/${record.id}/evidence/${photo.id}`;
      const anchor = element('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      const image = element('img');
      image.src = url;
      image.alt = `Evidence supplied by ${photo.author}`;
      anchor.append(image);
      photos.append(anchor);
    });
    section.append(element('h3', 'Evidence photos'), photos);
    if (record.status !== 'resolved') {
      const form = element('form');
      const input = element('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.multiple = true;
      input.required = true;
      form.append(
        field(
          'Attach up to 5 photos, 5 MB each. Maximum 20 per return.',
          input,
        ),
        button('Upload evidence'),
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void submit(form, () => {
          const data = new FormData();
          for (const file of input.files ?? []) data.append('files', file);
          return api(`/returns/${record.id}/evidence`, {
            method: 'POST',
            body: data,
          });
        });
      });
      section.append(form);
    }
    return section;
  }
  function requestForm(orders: OrderOption[]) {
    const section = element('section');
    section.append(element('h2', 'Request a return'));
    if (!orders.length) {
      section.append(
        element(
          'p',
          'No delivered items are currently available for a new return request.',
        ),
      );
      return section;
    }
    const form = element('form');
    const select = element('select');
    orders.forEach((order, index) => {
      const option = element(
        'option',
        `Order ${order.orderId} · Seller shipment ${order.sellerOrderId}`,
      );
      option.value = String(index);
      select.append(option);
    });
    const selected = orders.findIndex(
      (order) =>
        order.checkoutId ===
        new URLSearchParams(location.search).get('checkout'),
    );
    if (selected >= 0) select.value = String(selected);
    const rows = element('div');
    let read: (() => {
      productId: string;
      quantity: number;
      reason: string;
    })[] = [];
    function renderLines() {
      rows.replaceChildren();
      read = orders[Number(select.value)].items
        .filter((item) => item.available > 0)
        .map((item) => {
          const row = element('div', '', 'return-line');
          row.append(element('h3', item.name));
          const qty = number(
            `Quantity to return (up to ${item.available})`,
            0,
            item.available,
          );
          const reason = element('input');
          reason.maxLength = 500;
          row.append(qty.row, field('Reason for return', reason));
          rows.append(row);
          return () => ({
            productId: item.productId,
            quantity: Number(qty.input.value),
            reason: reason.value,
          });
        });
    }
    select.addEventListener('change', renderLines);
    renderLines();
    form.append(
      field('Delivered seller shipment', select),
      rows,
      element(
        'p',
        'The seller will review your request before return shipping is arranged.',
      ),
      button('Submit return request'),
    );
    let requestId = crypto.randomUUID();
    let payload = '';
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const order = orders[Number(select.value)];
      const items = read.map((fn) => fn()).filter((item) => item.quantity > 0);
      const next = JSON.stringify({
        checkoutId: order.checkoutId,
        sellerOrderId: order.sellerOrderId,
        items,
      });
      if (payload && next !== payload) requestId = crypto.randomUUID();
      payload = next;
      void submit(form, async () => {
        const result = await api('/returns/requests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: requestId, ...JSON.parse(next) }),
        });
        if (!stopped) location.assign(`/returns/${result.id}`);
      });
    });
    section.append(form);
    return section;
  }
  async function refresh() {
    if (loading || stopped || document.hidden) return;
    loading = true;
    try {
      const data = await api(
        returnId ? `/returns/${returnId}/data` : '/returns/data',
      );
      if (stopped) return;
      const next = JSON.stringify(data);
      status.textContent = '';
      if (signature === next) return;
      signature = next;
      if (returnId) content.replaceChildren(details(data));
      else {
        const list = element('section');
        list.append(element('h2', 'Your returns'));
        if (!data.returns.length) list.append(element('p', 'No returns yet.'));
        (data.returns as ReturnView[]).forEach((record) => {
          const row = element('div', '', 'return-line');
          row.append(
            element(
              'h3',
              `${record.kind === 'failed_delivery' ? 'Undelivered shipment' : 'Buyer request'} · ${label(record.status)}`,
            ),
            element(
              'p',
              record.items
                .map((item) => `${item.name} × ${item.quantity}`)
                .join(', '),
            ),
            link('Open return', `/returns/${record.id}`),
          );
          list.append(row);
        });
        content.replaceChildren(list, requestForm(data.orders));
      }
      status.textContent = '';
    } catch (error) {
      if (!stopped)
        status.textContent =
          error instanceof Error ? error.message : 'Unable to load returns.';
    } finally {
      loading = false;
    }
  }
  content.addEventListener('input', () => {
    dirty = true;
  });
  document.getElementById('returns-refresh')!.addEventListener('click', () => {
    dirty = false;
    signature = '';
    void refresh();
  });
  const timer = setInterval(() => {
    if (!dirty && !busy) void refresh();
  }, 5000);
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearInterval(timer);
    content.replaceChildren();
    status.textContent = '';
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) location.reload();
  });
  void refresh();
})();
