/* global Survey, SurveyKeyboard */
(() => {
    'use strict';
    const container = document.getElementById('registration-form');
    const status = document.getElementById('registration-status');
    const verification = document.getElementById('verification');
    const contacts = document.getElementById('verification-contacts');
    let challenge;
    let busy = false;
    let timer;
    const countdowns = [];

    const message = (text, error = false) => {
        status.textContent = text;
        status.classList.toggle('form-error', error);
    };

    async function api(path, body) {
        const response = await fetch(path, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(Array.isArray(data.message) ? data.message.join(' · ') : data.message || 'Request failed');
        return data;
    }

    function updateButtons() {
        for (const { button, resendAt, verified } of countdowns) {
            const seconds = Math.max(0, Math.ceil((Date.parse(resendAt) - Date.now()) / 1000));
            button.disabled = busy || verified || seconds > 0;
            button.textContent = verified ? 'Verified' : seconds ? `Resend in ${seconds}s` : 'Resend code';
        }
        for (const button of contacts.querySelectorAll('.verify-button')) button.disabled = busy;
    }

    function showChallenge(nextChallenge) {
        challenge = nextChallenge;
        container.hidden = true;
        verification.hidden = false;
        contacts.replaceChildren();
        countdowns.length = 0;
        clearInterval(timer);
        document.getElementById('otp-dev-notice').hidden = !challenge.contacts.some(contact => contact.delivery === 'LOG');
        for (const contact of challenge.contacts) {
            const form = document.createElement('form');
            form.className = 'otp-contact';
            const label = document.createElement('label');
            label.textContent = `${contact.channel === 'email' ? 'Email' : 'Phone'} · ${contact.destination}`;
            form.append(label);
            if (contact.verified) {
                const verified = document.createElement('p');
                verified.className = 'verified-contact';
                verified.textContent = '✓ Verified';
                form.append(verified);
            } else {
                const input = document.createElement('input');
                input.id = `otp-${contact.channel}`;
                label.htmlFor = input.id;
                input.name = 'code'; input.type = 'text'; input.inputMode = 'numeric';
                input.autocomplete = 'one-time-code'; input.pattern = '[0-9]{6}';
                input.required = true; input.maxLength = 6;
                input.placeholder = '123456';
                const actions = document.createElement('div');
                actions.className = 'otp-actions';
                const verify = document.createElement('button');
                verify.type = 'submit'; verify.className = 'nav-button nav-button-primary verify-button';
                verify.textContent = 'Verify code';
                const resend = document.createElement('button');
                resend.type = 'button'; resend.className = 'nav-button nav-button-secondary';
                actions.append(verify, resend);
                form.append(input, actions);
                countdowns.push({ button: resend, resendAt: contact.resendAt, verified: false });
                form.addEventListener('submit', async event => {
                    event.preventDefault();
                    if (busy) return;
                    busy = true; updateButtons(); message('Checking your code…');
                    try {
                        const result = await api('/auth/register/verify', {
                            challengeId: challenge.challengeId, channel: contact.channel, code: input.value.trim(),
                        });
                        if (result.registered) {
                            clearInterval(timer);
                            message('Account created. Taking you to the shop…');
                            window.location.assign('/shop');
                        } else {
                            message('Contact verified. Please verify your remaining contact.');
                            showChallenge(result.challenge);
                        }
                    } catch (error) { message(error.message, true); }
                    finally { busy = false; updateButtons(); }
                });
                resend.addEventListener('click', async () => {
                    if (busy) return;
                    busy = true; updateButtons(); message('Sending a new code…');
                    try {
                        const result = await api('/auth/register/resend', { challengeId: challenge.challengeId, channel: contact.channel });
                        showChallenge(result);
                        message('A new code is queued for delivery. The previous code no longer works.');
                    } catch (error) { message(error.message, true); }
                    finally { busy = false; updateButtons(); }
                });
            }
            contacts.append(form);
        }
        timer = setInterval(updateButtons, 1000);
        updateButtons();
        contacts.querySelector('input')?.focus();
    }

    async function init() {
        try {
            const response = await fetch('/auth/register/schema', { credentials: 'same-origin' });
            if (!response.ok) throw new Error('Unable to load the registration form');
            const schema = await response.json();
            const survey = new Survey.Model(schema);
            SurveyKeyboard.attach(container, () => survey, () => busy);
            survey.applyTheme({ themeName: 'default', colorPalette: 'light', isPanelless: true });
            survey.onCompleting.add((sender, options) => {
                options.allow = false;
                if (busy) return;
                const data = sender.data;
                if (!data.email?.trim() && !data.phone?.trim()) {
                    message('Provide at least one email address or phone number.', true);
                    return;
                }
                const user = {};
                for (const key of ['typeOfUser', 'email', 'phone', 'password', 'confirmPassword', 'firstName', 'lastName', 'dob', 'nationality', 'pob']) {
                    if (data[key] !== undefined && data[key] !== '') user[key] = data[key];
                }
                if (user.typeOfUser === 'buyer') {
                    user.buyerProfile = {};
                    if (data.deliveryAddress) user.buyerProfile.deliveryAddress = data.deliveryAddress;
                } else {
                    user.sellerProfile = {};
                    for (const key of ['companyName', 'businessAddress', 'vatNumber']) {
                        if (data[key]) user.sellerProfile[key] = data[key];
                    }
                }
                busy = true; sender.readOnly = true; message('Preparing your verification codes…');
                api('/auth/register', { user }).then(result => {
                    sender.clear(); sender.dispose(); container.replaceChildren();
                    message('Confirm your contacts to finish registration.');
                    showChallenge(result);
                }).catch(error => {
                    sender.readOnly = false; message(error.message, true);
                }).finally(() => { busy = false; updateButtons(); });
            });
            container.replaceChildren();
            survey.render(container);
        } catch (error) {
            container.replaceChildren(); message(error.message, true);
        }
    }
    window.addEventListener('pagehide', () => clearInterval(timer));
    init();
})();
