(() => {
    const dialog = document.getElementById('delete-product-dialog');
    if (!dialog) return;
    const confirm = document.getElementById('confirm-delete-product');
    const cancel = document.getElementById('cancel-delete-product');
    const status = document.getElementById('delete-product-status');
    let opener, id, busy = false;
    document.querySelector('.products').addEventListener('click', event => {
        const button = event.target.closest('button[data-delete-product]');
        if (!button || busy) return;
        opener = button; id = button.dataset.deleteProduct;
        document.getElementById('delete-product-name').textContent = button.closest('.product').querySelector('h2').textContent;
        status.textContent = ''; status.classList.remove('form-error');
        dialog.showModal(); cancel.focus();
    });
    cancel.addEventListener('click', () => { if (!busy) dialog.close(); });
    dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    dialog.addEventListener('close', () => opener?.focus());
    confirm.addEventListener('click', async () => {
        if (busy || !id) return;
        busy = true; confirm.disabled = true; cancel.disabled = true;
        status.classList.remove('form-error'); status.textContent = 'Deleting product…';
        try {
            const response = await fetch(`/products/${encodeURIComponent(id)}`, {
                method: 'DELETE', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
            });
            if (!response.ok) {
                const body = await response.json();
                if (response.status === 401) throw new Error('Your session has expired. Log in again before deleting.');
                throw new Error(Array.isArray(body.message) ? body.message.join(' · ') : body.message || 'Unable to delete this product.');
            }
            status.textContent = 'Product deleted. Updating the catalog…';
            window.location.assign('/shop');
        } catch (error) { status.textContent = error.message || 'Unable to delete. Please try again.'; status.classList.add('form-error'); }
        finally { busy = false; confirm.disabled = false; cancel.disabled = false; }
    });
})();
