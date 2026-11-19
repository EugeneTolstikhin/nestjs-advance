// Covers server-rendered orders and dynamically rendered return product photos.
document.addEventListener(
  'error',
  (event) => {
    const image = event.target;
    if (
      image instanceof HTMLImageElement &&
      image.hasAttribute('data-order-image')
    )
      image.hidden = true;
  },
  true,
);
