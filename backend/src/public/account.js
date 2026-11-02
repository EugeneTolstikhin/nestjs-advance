/* global Survey, SurveyKeyboard */
(() => {
    const status = document.getElementById('account-status');
    const surveys = [];
    let busy = false;
    function message(text, error = false) {
        status.textContent = text;
        status.classList.toggle('form-error', error);
    }
    (async () => {
        try {
            const response = await fetch('/account/schema', { credentials: 'same-origin' });
            if (response.status === 401) { window.location.replace('/auth/login'); return; }
            if (!response.ok) throw new Error('Unable to load your profiles. Please refresh to try again.');
            const schema = await response.json();
            for (const role of ['buyer', 'seller']) {
                const container = document.getElementById(`${role}-profile-form`);
                const survey = new Survey.Model(schema[role].form);
                SurveyKeyboard.attach(container, () => survey, () => busy);
                surveys.push(survey);
                survey.data = schema[role].data;
                survey.applyTheme({ themeName: 'default', colorPalette: 'light', isPanelless: true });
                survey.onCompleting.add((sender, options) => {
                    options.allow = false;
                    if (busy) return;
                    // Send only this role's profile, never identity or permissions.
                    const data = {};
                    const fields = role === 'buyer' ? ['deliveryAddress'] : ['companyName', 'businessAddress', 'vatNumber'];
                    for (const field of fields) if (typeof sender.data[field] === 'string') data[field] = sender.data[field];
                    busy = true; surveys.forEach(model => { model.readOnly = true; });
                    message('Saving your profile…');
                    fetch(`/account/${role}`, {
                        method: 'POST', credentials: 'same-origin',
                        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
                    }).then(async result => {
                        const body = await result.json();
                        if (!result.ok) throw new Error(Array.isArray(body.message) ? body.message.join(' · ') : body.message || 'Unable to save your profile');
                        message('Profile saved. Updating your account…');
                        window.location.replace('/account');
                    }).catch(error => { message(error.message, true); })
                        .finally(() => { busy = false; surveys.forEach(model => { model.readOnly = false; }); });
                });
                container.replaceChildren(); survey.render(container);
            }
        } catch (error) { message(error.message, true); }
    })();
})();
