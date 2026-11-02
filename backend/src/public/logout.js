(() => {
    const button = document.getElementById('logout-button');
    const error = document.getElementById('logout-error');
    if (!button || !error) return;

    button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Logging out…';
        error.hidden = true;
        try {
            const response = await fetch('/auth/logout', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            if (!response.ok) throw new Error('Logout failed');
            window.location.replace('/');
        } catch {
            error.textContent = 'Could not log out. Please try again.';
            error.hidden = false;
            button.disabled = false;
            button.textContent = 'Logout';
        }
    });
})();
