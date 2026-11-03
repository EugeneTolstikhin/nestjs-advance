/* global Survey, SurveyKeyboard */
(() => {
    const id = document.getElementById('product-page').dataset.productId;
    const container = document.getElementById('product-form');
    const status = document.getElementById('product-status');
    let busy = false;
    function message(text, error = false) {
        status.textContent = text;
        status.classList.toggle('form-error', error);
    }
    async function result(response) {
        const data = await response.json();
        if (response.status === 401) throw new Error('Your session has expired. Log in again before saving.');
        if (response.status === 403) throw new Error('Seller access is required to save products.');
        if (response.status === 404) throw new Error('This product no longer exists. Return to the products page.');
        if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(' · ') : data.message || 'Unable to save the product. Please try again.');
        return data;
    }
    (async () => {
        try {
            const schema = await result(await fetch('/shop/product-schema', { credentials: 'same-origin' }));
            const product = id ? await result(await fetch(`/products/${encodeURIComponent(id)}`, { credentials: 'same-origin' })) : {};
            const survey = new Survey.Model(schema);
            survey.completeText = id ? 'Save changes' : 'Create product';
            survey.applyTheme({ themeName: 'default', colorPalette: 'light', isPanelless: true });
            if (id) survey.data = { name: product.name, description: product.description, price: product.price, imageUrl: product.imageUrl ?? '' };
            SurveyKeyboard.attach(container, () => survey, () => busy);
            survey.onCompleting.add((sender, options) => {
                options.allow = false;
                if (busy) return;
                const data = { name: sender.data.name.trim(), description: sender.data.description.trim(), price: Number(sender.data.price) };
                if (sender.data.imageUrl?.trim()) data.imageUrl = sender.data.imageUrl.trim();
                busy = true; sender.readOnly = true; message(id ? 'Saving changes…' : 'Creating product…');
                fetch(id ? `/products/${encodeURIComponent(id)}` : '/products', {
                    method: id ? 'PUT' : 'POST', credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
                }).then(result).then(() => {
                    message('Product saved. Returning to the catalog…');
                    window.location.assign('/shop');
                }).catch(error => { message(error.message || 'Unable to save. Please try again.', true); })
                    .finally(() => { busy = false; sender.readOnly = false; });
            });
            container.replaceChildren(); survey.render(container); survey.focusFirstQuestion();
        } catch (error) { container.replaceChildren(); message(error.message || 'Unable to load the product form. Please refresh.', true); }
    })();
})();
