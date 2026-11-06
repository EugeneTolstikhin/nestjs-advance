(() => {
    const root = document.getElementById('shopping-cart');
    const list = document.getElementById('cart-items');
    const status = document.getElementById('cart-status');
    let busy = false, stopped = false, version = 0, lastView = '', denied = false;
    const rowViews = new Map();
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    const money = value => `${Number(value).toFixed(2)}€`;
    function notice(target, text, error) {
        if (target.textContent !== text) target.textContent = text;
        target.classList.toggle('form-error', !!error);
    }
    function authNotice(target, code) {
        notice(target, code === 401 ? 'Log in with a buyer account to add items or view your shopping cart.'
            : 'A buyer profile is required to use the shopping cart.', true);
        const link = node('a', code === 401 ? 'Login' : 'My account');
        link.href = code === 401 ? '/auth/login' : '/account';
        target.append(document.createTextNode(' '), link);
    }
    async function api(path, options = {}) {
        const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
        const body = await response.json();
        if (!response.ok) {
            const error = new Error(Array.isArray(body.message) ? body.message.join(' · ') : body.message || 'Shopping cart request failed.');
            error.status = response.status; throw error;
        }
        return body;
    }
    function render(cart, restoreFocus) {
        const snapshot = JSON.stringify(cart);
        if (snapshot === lastView && !denied) return;
        const focused = document.activeElement;
        const focusId = restoreFocus?.id ?? focused?.closest('[data-cart-item]')?.dataset.cartItem;
        const focusAction = restoreFocus?.action ?? focused?.dataset.cartAction;
        const rows = cart.items.map(item => {
            const signature = JSON.stringify([item.name, item.thumbnail, item.available]);
            const previous = rowViews.get(item.productId);
            if (previous?.signature === signature && previous.row.parentNode === list) {
                const row = previous.row;
                const quantity = row.querySelector('.cart-quantity');
                if (quantity.textContent !== String(item.quantity)) quantity.textContent = String(item.quantity);
                if (item.available) {
                    row.querySelector('.price').textContent = `Subtotal: ${money(item.lineTotal)}`;
                    row.querySelector('.cart-item-details > p').textContent = `Unit price: ${money(item.unitPrice)}`;
                }
                const increase = row.querySelector('[data-cart-action="increase"]');
                const unavailable = !item.available || item.quantity >= cart.maxQuantity;
                increase.disabled = unavailable;
                if (unavailable) increase.dataset.unavailable = 'true';
                else delete increase.dataset.unavailable;
                return row;
            }
            const row = node('li', '', 'cart-item'); row.dataset.cartItem = item.productId;
            let image;
            if (item.thumbnail) { image = node('img', '', 'cart-image'); image.src = item.thumbnail; image.alt = ''; image.loading = 'lazy'; }
            else { image = node('div', 'N.', 'cart-image cart-placeholder'); image.setAttribute('aria-hidden', 'true'); }
            const details = node('div', '', 'cart-item-details'); details.append(node('h2', item.name));
            if (item.available) details.append(node('p', `Unit price: ${money(item.unitPrice)}`), node('p', `Subtotal: ${money(item.lineTotal)}`, 'price'));
            else details.append(node('p', 'This product is no longer available. You can remove it from your cart.', 'form-error'));
            const actions = node('div', '', 'product-actions');
            const button = (action, text, label) => {
                const control = node('button', text, `nav-button nav-button-${action === 'remove' ? 'danger' : 'secondary'}`);
                control.type = 'button'; control.dataset.cartAction = action; control.setAttribute('aria-label', label);
                if (action === 'increase' && (!item.available || item.quantity >= cart.maxQuantity)) { control.disabled = true; control.dataset.unavailable = 'true'; }
                return control;
            };
            const quantity = node('span', String(item.quantity), 'cart-quantity'); quantity.setAttribute('aria-label', `Quantity for ${item.name}`);
            actions.append(button('decrease', '−', `Remove one ${item.name}`), quantity,
                button('increase', '+', `Add one ${item.name}`), button('remove', 'Remove', `Remove ${item.name} from cart`));
            details.append(actions); row.append(image, details);
            rowViews.set(item.productId, { row, signature });
            return row;
        });
        const retained = new Set(rows);
        for (const child of [...list.children]) {
            if (!retained.has(child)) child.remove();
        }
        rows.forEach((row, index) => {
            if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
        });
        for (const [id, view] of rowViews) {
            if (!retained.has(view.row)) rowViews.delete(id);
        }
        document.getElementById('cart-empty').hidden = rows.length > 0;
        document.getElementById('cart-summary').hidden = rows.length === 0;
        document.getElementById('cart-item-count').textContent = `${cart.itemCount} ${cart.itemCount === 1 ? 'item' : 'items'}`;
        document.getElementById('cart-total').textContent = money(cart.total);
        document.getElementById('cart-unavailable').hidden = !cart.unavailableCount;
        if (denied) notice(status, 'Your cart is up to date.');
        denied = false; lastView = snapshot;
        if (focusId && focusAction) {
            const row = [...list.children].find(item => item.dataset.cartItem === focusId);
            const next = row?.querySelector(`[data-cart-action="${focusAction}"]`);
            if (next && !next.disabled) next.focus();
            else if (!rows.length) document.getElementById('cart-empty').focus();
            else list.querySelector('button')?.focus();
        }
    }
    function handleError(error, target) {
        if ([401, 403].includes(error.status)) {
            authNotice(target, error.status);
            if (root) {
                denied = true; lastView = ''; list.replaceChildren(); rowViews.clear();
                document.getElementById('cart-empty').hidden = true;
                document.getElementById('cart-summary').hidden = true;
            }
        } else notice(target, error.message || 'Unable to update your cart. Please try again.', true);
    }
    async function refresh() {
        if (!root || stopped || busy || document.hidden) return;
        const ticket = ++version;
        try {
            const cart = await api('/cart/data');
            if (ticket === version && !busy && !stopped) render(cart);
        } catch (error) { if (ticket === version && !stopped) handleError(error, status); }
    }
    document.addEventListener('click', event => {
        const add = event.target.closest('button[data-add-to-cart]');
        const action = event.target.closest('button[data-cart-action]');
        if (add) void addProduct(add);
        else if (action && root) void changeCart(action);
    });
    async function addProduct(button) {
        if (button.disabled) return;
        const card = button.closest('.product');
        const target = card.querySelector('[data-cart-notice]');
        button.disabled = true; notice(target, 'Adding to your cart…');
        try {
            await api(`/cart/items/${encodeURIComponent(button.dataset.addToCart)}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
            });
            notice(target, `${card.querySelector('h2').textContent} added to your cart.`);
            const link = node('a', 'View cart'); link.href = '/cart'; target.append(document.createTextNode(' '), link);
        } catch (error) { handleError(error, target); }
        finally { button.disabled = false; }
    }
    async function changeCart(button) {
        if (busy || button.disabled) return;
        const id = button.closest('[data-cart-item]').dataset.cartItem;
        const restoreFocus = document.activeElement === button ? { id, action: button.dataset.cartAction } : undefined;
        const remove = button.dataset.cartAction === 'remove';
        busy = true; ++version; lastView = '';
        root.setAttribute('aria-busy', 'true'); root.querySelectorAll('button').forEach(control => { control.disabled = true; });
        try {
            const cart = await api(`/cart/items/${encodeURIComponent(id)}`, {
                method: remove ? 'DELETE' : 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: remove ? undefined : JSON.stringify({ delta: button.dataset.cartAction === 'increase' ? 1 : -1 }),
            });
            render(cart, restoreFocus); notice(status, remove ? 'Product removed from your cart.' : 'Cart quantity updated.');
        } catch (error) { handleError(error, status); }
        finally {
            busy = false; root.removeAttribute('aria-busy');
            root.querySelectorAll('button').forEach(control => { control.disabled = control.dataset.unavailable === 'true'; });
            if (restoreFocus && button.isConnected && !button.disabled) button.focus();
        }
    }
    let timer;
    if (root) {
        void refresh(); timer = setInterval(() => { void refresh(); }, 15000);
        window.addEventListener('focus', () => { void refresh(); });
        document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
        window.addEventListener('pageshow', event => {
            if (event.persisted) { stopped = false; lastView = ''; timer = setInterval(() => { void refresh(); }, 15000); void refresh(); }
        });
    }
    window.addEventListener('pagehide', () => {
        stopped = true; ++version; clearInterval(timer);
        if (root) {
            list.replaceChildren(); rowViews.clear(); lastView = '';
            document.getElementById('cart-summary').hidden = true;
            document.getElementById('cart-empty').hidden = true;
        }
    });
})();
