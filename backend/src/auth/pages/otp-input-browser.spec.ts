import { Window, type HTMLInputElement } from 'happy-dom';
import { clientScript } from '../../../test/client-script';

describe('Six-digit OTP editor', () => {
  let window: Window;
  let source: HTMLInputElement;
  let boxes: HTMLInputElement[];
  let control: { sync(value?: string): void; dispose(): void };
  beforeEach(() => {
    window = new Window({
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    window.document.body.innerHTML =
      '<form><label for="code">Verification code</label><input id="code" name="code" autocomplete="one-time-code" required pattern="[0-9]{6}"><button>Verify</button></form>';
    source = window.document.querySelector('input')!;
    window.eval(clientScript('otp-input'));
    const api = window as unknown as {
      OtpInput: { attach(input: unknown): typeof control };
    };
    control = api.OtpInput.attach(source);
    boxes = Array.from(
      window.document.querySelectorAll<HTMLInputElement>('.otp-digits input'),
    );
  });
  afterEach(async () => {
    control.dispose();
    await window.happyDOM.abort();
    window.close();
  });
  function type(index: number, value: string) {
    boxes[index].focus();
    boxes[index].value = value;
    boxes[index].dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  function key(index: number, value: string) {
    boxes[index].dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
  it('collects six digits, preserves leading zeroes, advances focus and leaves native form validation intact', () => {
    expect(boxes).toHaveLength(6);
    '012345'.split('').forEach((digit, index) => type(index, digit));
    expect(source.value).toBe('012345');
    expect(source.checkValidity()).toBe(true);
    expect(window.document.activeElement).toBe(boxes[5]);
    expect(boxes[0].getAttribute('aria-label')).toBe('Digit 1 of 6');
    expect(boxes[5].getAttribute('aria-label')).toBe('Digit 6 of 6');
    expect(source.tabIndex).toBe(-1);
    expect(source.getAttribute('aria-hidden')).toBe('true');
  });
  it('pastes a complete code into any square and handles full-code autofill without submitting', () => {
    const submitted = vi.fn();
    window.document
      .querySelector('form')!
      .addEventListener('submit', submitted);
    const data = new window.DataTransfer();
    data.setData('text', '01 23-45');
    boxes[3].dispatchEvent(
      new window.ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(source.value).toBe('012345');
    expect(boxes.map((box) => box.value)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    type(0, '654321');
    expect(source.value).toBe('654321');
    expect(submitted).not.toHaveBeenCalled();
  });
  it('supports arrows, replacing a middle digit and deleting without silently submitting an incomplete code', () => {
    type(0, '123456');
    boxes[2].focus();
    key(2, 'ArrowLeft');
    expect(window.document.activeElement).toBe(boxes[1]);
    key(1, 'ArrowRight');
    expect(window.document.activeElement).toBe(boxes[2]);
    type(2, '9');
    expect(source.value).toBe('129456');
    key(3, 'Backspace');
    expect(boxes[3].value).toBe('');
    expect(source.checkValidity()).toBe(false);
    key(3, 'Backspace');
    expect(window.document.activeElement).toBe(boxes[2]);
    expect(boxes[2].value).toBe('');
    type(2, '3');
    type(3, '4');
    expect(source.value).toBe('123456');
    key(5, 'Delete');
    expect(source.checkValidity()).toBe(false);
  });
  it('clears on model reset, forwards validation/disabled state and restores the source editor on dispose', async () => {
    type(0, '123456');
    source.value = '';
    control.sync();
    expect(boxes.every((box) => box.value === '')).toBe(true);
    source.disabled = true;
    source.setAttribute('aria-invalid', 'true');
    source.setAttribute('aria-errormessage', 'code-error');
    await vi.waitFor(() =>
      expect(boxes.every((box) => box.disabled)).toBe(true),
    );
    expect(boxes[0].getAttribute('aria-invalid')).toBe('true');
    expect(boxes[0].getAttribute('aria-errormessage')).toBe('code-error');
    control.dispose();
    expect(window.document.querySelector('.otp-digits')).toBeNull();
    expect(source.autocomplete).toBe('one-time-code');
    expect(source.hasAttribute('aria-hidden')).toBe(false);
  });
  it('ignores non-digits and redirects label/validation focus to the next square', () => {
    type(0, 'abc');
    expect(source.value).toBe('');
    type(0, '12');
    source.focus();
    expect(window.document.activeElement).toBe(boxes[2]);
    const parentClick = vi.fn();
    source.parentElement!.addEventListener('click', parentClick);
    boxes[0].click();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
