/* global Survey, SurveyUI */
(() => {
    'use strict';
    const container = document.getElementById('login-form');
    const status = document.getElementById('login-status');
    const actions = document.getElementById('login-code-actions');
    const resend = document.getElementById('login-resend');
    const back = document.getElementById('login-back');
    let schema, survey, mount, challenge, contact, busy = false, timer;

    function message(text, error = false) {
        status.textContent = text;
        status.classList.toggle('form-error', error);
    }
    async function api(path, body) {
        const response = await fetch(path, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(Array.isArray(result.message) ? result.message.join(' · ') : result.message || 'Login failed. Try again.');
        return result;
    }
    function updateButtons() {
        const seconds = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.resendAt) - Date.now()) / 1000)) : 0;
        resend.disabled = busy || seconds > 0;
        resend.textContent = seconds ? `Resend in ${seconds}s` : 'Resend code';
        back.disabled = busy;
    }
    function showForm(verification = false) {
        // Unmount the previous renderer before disposing its model. Removing its
        // children alone leaves a stale virtual DOM attached to the same element.
        if (mount) SurveyUI.unmountComponentAtNode(mount);
        survey?.clear(); survey?.dispose();
        mount = document.createElement('div');
        container.replaceChildren(mount);
        actions.hidden = !verification;
        survey = new Survey.Model(verification ? schema.verification : schema.credentials);
        survey.applyTheme({ themeName: 'default', colorPalette: 'light', isPanelless: true });
        survey.onCompleting.add((sender, options) => {
            options.allow = false;
            if (busy) return;
            const data = { ...sender.data };
            submit(data, verification);
        });
        survey.render(mount);
        survey.focusFirstQuestion();
    }
    async function submit(data, verification) {
        busy = true; survey.readOnly = true; updateButtons();
        try {
            if (verification) {
                message('Checking your code…');
                await api('/auth/login/otp/verify', { challengeId: challenge.challengeId, code: data.code.trim() });
                complete();
            } else if (data.method === 'password') {
                message('Logging in…');
                await api('/auth/login', { user: { username: data.email.trim(), password: data.password } });
                complete();
            } else {
                contact = { channel: data.method, contact: (data.method === 'phone' ? data.phone : data.email).trim() };
                message('Requesting a login code…');
                challenge = await api('/auth/login/otp', contact);
                message(challenge.message);
                showForm(true);
                clearInterval(timer); timer = setInterval(updateButtons, 1000);
            }
        } catch (error) { message(error.message || 'Unable to log in. Please try again.', true); }
        finally { busy = false; survey.readOnly = false; updateButtons(); }
    }
    function complete() {
        clearInterval(timer);
        survey.clear();
        message('You’re logged in. Taking you to the shop…');
        window.location.replace('/shop');
    }
    resend.addEventListener('click', async () => {
        if (busy || resend.disabled) return;
        busy = true; survey.readOnly = true; updateButtons(); message('Requesting a new code…');
        try {
            challenge = await api('/auth/login/otp', contact);
            survey.clear(); message(challenge.message);
        } catch (error) { message(error.message, true); }
        finally { busy = false; survey.readOnly = false; updateButtons(); }
    });
    back.addEventListener('click', () => {
        if (busy) return;
        clearInterval(timer); challenge = undefined; contact = undefined;
        message(''); showForm();
    });
    window.addEventListener('pagehide', () => clearInterval(timer));
    (async () => {
        try {
            const response = await fetch('/auth/login/schema', { credentials: 'same-origin' });
            if (!response.ok) throw new Error('Unable to load the login form. Refresh to try again.');
            schema = await response.json(); showForm();
        } catch (error) { container.replaceChildren(); message(error.message, true); }
    })();
})();
