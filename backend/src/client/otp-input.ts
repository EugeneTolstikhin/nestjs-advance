// Keep the existing form/SurveyJS value as the source of truth while exposing
// six small editors. No automatic submission: Enter and the submit button work.
globalThis.OtpInput = Object.freeze({
  attach(input, onChange) {
    input.dataset.otpSource = '';
    let committing = false;
    const oldTabIndex = input.getAttribute('tabindex');
    const oldAutocomplete = input.autocomplete;
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.autocomplete = 'off';
    const group = document.createElement('div');
    group.className = 'otp-digits';
    group.setAttribute('role', 'group');
    const label = input.getAttribute('aria-labelledby');
    if (label) group.setAttribute('aria-labelledby', label);
    else group.setAttribute('aria-label', 'Six-digit verification code');
    const boxes = Array.from({ length: 6 }, (_, index) => {
      const box = document.createElement('input');
      box.type = 'text';
      box.inputMode = 'numeric';
      box.autocomplete = index === 0 ? 'one-time-code' : 'off';
      // Some autofill services insert the entire code into the focused editor.
      box.maxLength = 6;
      box.setAttribute('aria-label', `Digit ${index + 1} of 6`);
      box.setAttribute('autocapitalize', 'off');
      box.spellcheck = false;
      group.append(box);
      return box;
    });
    // Do not let the SurveyJS container click handler steal focus from a digit.
    group.addEventListener('click', (event) => event.stopPropagation());
    input.after(group);
    function updateAttributes() {
      boxes.forEach((box) => {
        box.disabled = input.disabled;
        box.readOnly = input.readOnly;
        box.setAttribute(
          'aria-invalid',
          input.getAttribute('aria-invalid') ?? 'false',
        );
        const description = input.getAttribute('aria-describedby');
        if (description) box.setAttribute('aria-describedby', description);
        else box.removeAttribute('aria-describedby');
        const error = input.getAttribute('aria-errormessage');
        if (error) box.setAttribute('aria-errormessage', error);
        else box.removeAttribute('aria-errormessage');
      });
    }
    function sync(value = input.value) {
      if (!committing) {
        input.value = value;
        boxes.forEach((box, index) => {
          box.value = value[index] ?? '';
        });
      }
      updateAttributes();
    }
    function focus(index: number) {
      boxes[Math.max(0, Math.min(5, index))].focus();
      boxes[Math.max(0, Math.min(5, index))].select();
    }
    function commit() {
      input.value = boxes.map((box) => box.value).join('');
      committing = true;
      try {
        if (onChange) onChange(input.value);
        else {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } finally {
        committing = false;
      }
    }
    function insert(index: number, text: string) {
      const digits = text.replace(/\D/g, '').slice(0, 6);
      if (!digits) {
        boxes[index].value = '';
        commit();
        return;
      }
      // Full-code pastes/autofill replace all six digits, even from a middle box.
      const start = digits.length === 6 ? 0 : index;
      for (
        let offset = 0;
        offset < digits.length && start + offset < 6;
        offset++
      )
        boxes[start + offset].value = digits[offset];
      commit();
      focus(Math.min(5, start + digits.length));
    }
    boxes.forEach((box, index) => {
      box.addEventListener('focus', () => box.select());
      box.addEventListener('input', (event) => {
        if (!(event instanceof InputEvent) || !event.isComposing)
          insert(index, box.value);
      });
      box.addEventListener('compositionend', () => insert(index, box.value));
      box.addEventListener('paste', (event) => {
        if (box.disabled || box.readOnly) return;
        event.preventDefault();
        insert(index, event.clipboardData?.getData('text') ?? '');
      });
      box.addEventListener('keydown', (event) => {
        if (
          box.disabled ||
          box.readOnly ||
          event.isComposing ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey
        )
          return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          focus(index + (event.key === 'ArrowLeft' ? -1 : 1));
        } else if (event.key === 'Backspace') {
          event.preventDefault();
          const target = box.value ? index : Math.max(0, index - 1);
          boxes[target].value = '';
          commit();
          focus(target);
        } else if (event.key === 'Delete') {
          event.preventDefault();
          box.value = '';
          commit();
        }
      });
    });
    // Labels and SurveyJS validation can still focus the original editor.
    const redirectFocus = () => focus(Math.min(5, input.value.length));
    input.addEventListener('focus', redirectFocus);
    const observer = new MutationObserver(updateAttributes);
    observer.observe(input, {
      attributes: true,
      attributeFilter: [
        'disabled',
        'readonly',
        'aria-invalid',
        'aria-describedby',
        'aria-errormessage',
      ],
    });
    sync();
    return {
      input,
      sync,
      dispose() {
        observer.disconnect();
        group.remove();
        input.removeEventListener('focus', redirectFocus);
        delete input.dataset.otpSource;
        input.removeAttribute('aria-hidden');
        if (oldTabIndex === null) input.removeAttribute('tabindex');
        else input.setAttribute('tabindex', oldTabIndex);
        input.autocomplete = oldAutocomplete;
      },
    };
  },
});
