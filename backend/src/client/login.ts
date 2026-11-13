(() => {
  'use strict';
  const container = document.getElementById('login-form')!;
  const status = document.getElementById('login-status')!;
  const actions = document.getElementById('login-code-actions')!;
  const resend = document.querySelector<HTMLButtonElement>('#login-resend')!;
  const back = document.querySelector<HTMLButtonElement>('#login-back')!;
  let schema: { credentials: SurveySchema; verification: SurveySchema };
  let survey: SurveyModel;
  let mount: HTMLElement | undefined;
  let challenge: LoginChallenge | undefined;
  let contact: { channel: string; contact: string } | undefined;
  let otpControl: ReturnType<typeof OtpInput.attach> | undefined;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  SurveyKeyboard.attach(
    container,
    () => survey,
    () => busy,
  );

  function message(text: string, error = false) {
    status.textContent = text;
    status.classList.toggle('form-error', error);
  }
  async function api<T = LoginChallenge>(
    path: string,
    body: unknown,
  ): Promise<T> {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        Array.isArray(result.message)
          ? result.message.join(' · ')
          : result.message || 'Login failed. Try again.',
      );
    return result;
  }
  function updateButtons() {
    const seconds = challenge
      ? Math.max(
          0,
          Math.ceil((Date.parse(challenge.resendAt) - Date.now()) / 1000),
        )
      : 0;
    resend.disabled = busy || seconds > 0;
    resend.textContent = seconds ? `Resend in ${seconds}s` : 'Resend code';
    back.disabled = busy;
  }
  function showForm(verification = false) {
    // Unmount the previous renderer before disposing its model. Removing its
    // children alone leaves a stale virtual DOM attached to the same element.
    otpControl?.dispose();
    otpControl = undefined;
    if (mount) SurveyUI.unmountComponentAtNode(mount);
    survey?.clear();
    survey?.dispose();
    mount = document.createElement('div');
    container.replaceChildren(mount);
    actions.hidden = !verification;
    survey = new Survey.Model(
      verification ? schema.verification : schema.credentials,
    );
    survey.applyTheme({
      themeName: 'default',
      colorPalette: 'light',
      isPanelless: true,
    });
    survey.onCompleting.add((sender, options) => {
      options.allow = false;
      if (busy) return;
      const data = { ...sender.data };
      void submit(data, verification);
    });
    if (verification) {
      survey.onAfterRenderQuestion.add((_sender, options) => {
        if (options.question.name !== 'code') return;
        const input =
          options.htmlElement.querySelector<HTMLInputElement>('input');
        if (!input || otpControl?.input === input) return;
        otpControl?.dispose();
        otpControl = OtpInput.attach(input, (value) =>
          survey.setValue('code', value),
        );
      });
      survey.onValueChanged.add((sender, options) => {
        if (options.name === 'code') {
          otpControl?.sync(String(sender.getValue('code') ?? ''));
        }
      });
    }
    survey.render(mount);
    survey.focusFirstQuestion();
  }
  async function submit(data: Record<string, string>, verification: boolean) {
    busy = true;
    survey.readOnly = true;
    updateButtons();
    try {
      if (verification) {
        message('Checking your code…');
        await api('/auth/login/otp/verify', {
          challengeId: challenge!.challengeId,
          code: data.code.trim(),
        });
        complete();
      } else if (data.method === 'password') {
        message('Logging in…');
        await api('/auth/login', {
          user: { username: data.email.trim(), password: data.password },
        });
        complete();
      } else {
        contact = {
          channel: data.method,
          contact: (data.method === 'phone' ? data.phone : data.email).trim(),
        };
        message('Requesting a login code…');
        challenge = await api('/auth/login/otp', contact);
        message(challenge!.message);
        showForm(true);
        clearInterval(timer);
        timer = setInterval(updateButtons, 1000);
      }
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error(
              typeof cause === 'object' && cause !== null && 'message' in cause
                ? String(cause.message)
                : 'Unexpected error',
            );
      message(error.message || 'Unable to log in. Please try again.', true);
    } finally {
      busy = false;
      survey.readOnly = false;
      updateButtons();
    }
  }
  function complete() {
    clearInterval(timer);
    survey.clear();
    otpControl?.sync('');
    message('You’re logged in. Taking you to the shop…');
    window.location.replace('/shop');
  }
  resend.addEventListener('click', async () => {
    if (busy || resend.disabled) return;
    busy = true;
    survey.readOnly = true;
    updateButtons();
    message('Requesting a new code…');
    try {
      challenge = await api('/auth/login/otp', contact);
      survey.clear();
      otpControl?.sync('');
      message(challenge!.message);
    } catch (cause) {
      const error =
        cause instanceof Error
          ? cause
          : new Error(
              typeof cause === 'object' && cause !== null && 'message' in cause
                ? String(cause.message)
                : 'Unexpected error',
            );
      message(error.message, true);
    } finally {
      busy = false;
      survey.readOnly = false;
      updateButtons();
    }
  });
  back.addEventListener('click', () => {
    if (busy) return;
    clearInterval(timer);
    challenge = undefined;
    contact = undefined;
    message('');
    showForm();
  });
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    otpControl?.dispose();
  });
  void (async () => {
    try {
      const response = await fetch('/auth/login/schema', {
        credentials: 'same-origin',
      });
      if (!response.ok)
        throw new Error('Unable to load the login form. Refresh to try again.');
      schema = await response.json();
      showForm();
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
      message(error.message, true);
    }
  })();
})();
