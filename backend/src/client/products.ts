(() => {
  const dialog = document.querySelector<HTMLDialogElement>(
    '#delete-product-dialog',
  );
  if (!dialog) return;
  const confirm = document.querySelector<HTMLButtonElement>(
    '#confirm-delete-product',
  )!;
  const cancel = document.querySelector<HTMLButtonElement>(
    '#cancel-delete-product',
  )!;
  const status = document.getElementById('delete-product-status')!;
  let opener: HTMLButtonElement | undefined,
    id: string | undefined,
    busy = false;
  document.querySelector('.products')!.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>(
      'button[data-delete-product]',
    );
    if (!button || busy) return;
    opener = button;
    id = button.dataset.deleteProduct;
    document.getElementById('delete-product-name')!.textContent = button
      .closest('.product')!
      .querySelector('h2')!.textContent;
    status.textContent = '';
    status.classList.remove('form-error');
    dialog.showModal();
    cancel.focus();
  });
  cancel.addEventListener('click', () => {
    if (!busy) dialog.close();
  });
  dialog.addEventListener('cancel', (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener('close', () => opener?.focus());
  confirm.addEventListener('click', async () => {
    if (busy || !id) return;
    busy = true;
    confirm.disabled = true;
    cancel.disabled = true;
    status.classList.remove('form-error');
    status.textContent = 'Deleting product…';
    try {
      const response = await fetch(`/products/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        const body = await response.json();
        if (response.status === 401)
          throw new Error(
            'Your session has expired. Log in again before deleting.',
          );
        throw new Error(
          Array.isArray(body.message)
            ? body.message.join(' · ')
            : body.message || 'Unable to delete this product.',
        );
      }
      status.textContent = 'Product deleted. Updating the catalog…';
      window.location.assign('/shop');
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error(
              typeof cause === 'object' && cause !== null && 'message' in cause
                ? String(cause.message)
                : 'Unexpected error',
            );
      status.textContent =
        error.message || 'Unable to delete. Please try again.';
      status.classList.add('form-error');
    } finally {
      busy = false;
      confirm.disabled = false;
      cancel.disabled = false;
    }
  });
})();
