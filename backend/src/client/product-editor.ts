(() => {
  const id = document.getElementById('product-page')!.dataset.productId;
  const container = document.getElementById('product-form')!;
  const status = document.getElementById('product-status')!;
  let busy = false;
  function message(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('form-error', error);
  }
  async function result<T>(response: Response): Promise<T> {
    const data = await response.json();
    if (response.status === 401)
      throw new Error('Your session has expired. Log in again before saving.');
    if (response.status === 403)
      throw new Error('Seller access is required to save products.');
    if (response.status === 404)
      throw new Error(
        'This product no longer exists. Return to the products page.',
      );
    if (!response.ok)
      throw new Error(
        Array.isArray(data.message)
          ? data.message.join(' · ')
          : data.message || 'Unable to save the product. Please try again.',
      );
    return data;
  }
  void (async () => {
    try {
      const schema = await result<SurveySchema>(
        await fetch('/shop/product-schema', { credentials: 'same-origin' }),
      );
      const product: {
        name?: string;
        description?: string;
        price?: number;
        stock?: number;
        media?: SavedMedia[];
      } = id
        ? await result(
            await fetch(`/products/${encodeURIComponent(id)}`, {
              credentials: 'same-origin',
            }),
          )
        : {};
      const mediaRoot = document.getElementById('product-media')!;
      const uploader = mediaRoot
        ? await ProductMediaUploader.create(mediaRoot, product.media ?? [])
        : null;
      const survey = new Survey.Model(schema);
      survey.completeText = id ? 'Save changes' : 'Create product';
      survey.applyTheme({
        themeName: 'default',
        colorPalette: 'light',
        isPanelless: true,
      });
      survey.getQuestionByName('restockQuantity').visible = !!id;
      if (id)
        survey.data = {
          name: product.name,
          description: product.description,
          price: product.price,
          stock: product.stock ?? 0,
        };
      SurveyKeyboard.attach(
        container,
        () => survey,
        () => busy,
      );
      survey.onCompleting.add((sender, options) => {
        options.allow = false;
        if (busy) return;
        const data: {
          name: string;
          description: string;
          price: number;
          mediaIds?: string[];
          stock?: number;
          expectedStock?: number;
          restockQuantity?: number;
        } = {
          name: sender.data.name.trim(),
          description: sender.data.description.trim(),
          price: Number(sender.data.price),
        };
        if (id) {
          const stock = Number(sender.data.stock);
          const restock = Number(sender.data.restockQuantity ?? 0);
          if (stock !== (product.stock ?? 0)) {
            data.stock = stock;
            data.expectedStock = product.stock ?? 0;
          }
          if (restock > 0) data.restockQuantity = restock;
          if (data.stock !== undefined && data.restockQuantity !== undefined) {
            message(
              'Correct the stock count or add a delivery, not both at once.',
              true,
            );
            return;
          }
        } else data.stock = Number(sender.data.stock);
        try {
          if (uploader) data.mediaIds = uploader.ids();
        } catch (cause) {
          const error =
            cause instanceof Error
              ? cause
              : new Error(
                  typeof cause === 'object' &&
                    cause !== null &&
                    'message' in cause
                    ? String(cause.message)
                    : 'Unexpected error',
                );
          message(error.message, true);
          return;
        }
        busy = true;
        uploader?.setLocked(true);
        sender.readOnly = true;
        message(id ? 'Saving changes…' : 'Creating product…');
        fetch(id ? `/products/${encodeURIComponent(id)}` : '/products', {
          method: id ? 'PUT' : 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })
          .then(result)
          .then(async () => {
            await uploader?.markSaved();
            message('Product saved. Returning to the catalog…');
            window.location.assign('/shop');
          })
          .catch((error) => {
            message(error.message || 'Unable to save. Please try again.', true);
          })
          .finally(() => {
            busy = false;
            uploader?.setLocked(false);
            sender.readOnly = false;
          });
      });
      container.replaceChildren();
      survey.render(container);
      survey.focusFirstQuestion();
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error(
              typeof cause === 'object' && cause !== null && 'message' in cause
                ? String(cause.message)
                : 'Unexpected error',
            );
      container.replaceChildren();
      message(
        error.message || 'Unable to load the product form. Please refresh.',
        true,
      );
    }
  })();
})();
