(() => {
    for (const carousel of document.querySelectorAll('[data-carousel]')) {
        const slides = [...carousel.querySelectorAll('.carousel-slide')];
        const thumbs = [...carousel.querySelectorAll('[data-carousel-thumb]')];
        const count = carousel.querySelector('[data-carousel-count]');
        if (!slides.length) continue;
        let current = 0;
        function show(index) {
            current = (index + slides.length) % slides.length;
            slides.forEach((slide, i) => {
                slide.hidden = i !== current;
                if (i !== current) slide.querySelectorAll('video').forEach(video => video.pause());
            });
            thumbs.forEach((button, i) => button.setAttribute('aria-current', String(i === current)));
            if (count) count.textContent = `${current + 1} / ${slides.length}`;
        }
        const navigation = carousel.querySelector('.carousel-navigation');
        const thumbnails = carousel.querySelector('.carousel-thumbnails');
        if (navigation) navigation.hidden = slides.length < 2;
        if (thumbnails) thumbnails.hidden = slides.length < 2;
        carousel.querySelector('[data-carousel-prev]')?.addEventListener('click', () => show(current - 1));
        carousel.querySelector('[data-carousel-next]')?.addEventListener('click', () => show(current + 1));
        thumbs.forEach((button, i) => button.addEventListener('click', () => show(i)));
        carousel.addEventListener('keydown', event => {
            // Native video controls keep their seeking/volume keyboard shortcuts.
            if (event.target.closest('video') || event.ctrlKey || event.metaKey || event.altKey) return;
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            show(event.key === 'Home' ? 0 : event.key === 'End' ? slides.length - 1 : current + (event.key === 'ArrowRight' ? 1 : -1));
            if (event.target.closest('[data-carousel-thumb]')) thumbs[current]?.focus();
        });
        show(0);
    }
})();
