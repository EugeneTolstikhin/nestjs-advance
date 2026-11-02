import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { Model } from 'survey-core';
import { loginCodeForm, loginForm } from './login-form';

const script = readFileSync('src/public/login.js', 'utf8');
const core = readFileSync('node_modules/survey-core/survey.core.min.js', 'utf8');
const ui = readFileSync('node_modules/survey-js-ui/survey-js-ui.min.js', 'utf8');

describe('Login page with the actual SurveyJS renderer', () => {
    let models: Model[];
    let window: Window;
    let document: Window['document'];
    let globals: { Survey: typeof import('survey-core'); SurveyUI: typeof import('survey-js-ui') };
    let fetchMock: ReturnType<typeof vi.fn>;
    let redirect: ReturnType<typeof vi.spyOn>;
    const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
    const challenge = () => ({ challengeId: 'a'.repeat(64), message: 'Check your code', resendAt: new Date(Date.now() - 1000).toISOString() });
    const current = () => models[models.length - 1];
    const codeInput = () => document.querySelector<HTMLInputElement>('input[autocomplete="one-time-code"]');

    beforeEach(() => {
        models = [];
        // Evaluate only the installed local bundles and our own login script.
        window = new Window({ settings: { enableJavaScriptEvaluation: true,
            suppressInsecureJavaScriptEnvironmentWarning: true } });
        document = window.document;
        window.eval(core); window.eval(ui);
        globals = window as unknown as typeof globals;
        document.body.innerHTML = '<div id="login-form"></div><p id="login-status"></p><div id="login-code-actions" hidden></div><button id="login-resend"></button><button id="login-back"></button>';
        const OriginalModel = globals.Survey.Model;
        globals.Survey.Model = class extends OriginalModel {
            constructor(schema: object) { super(schema); models.push(this); }
        };
        fetchMock = vi.fn().mockImplementation(async (path: string) => {
            if (path === '/auth/login/schema') return response({ credentials: loginForm(), verification: loginCodeForm() });
            if (path === '/auth/login/otp') return response(challenge());
            return response({ access_token: 'test-session' });
        });
        window.fetch = fetchMock;
        redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    });
    afterEach(() => {
        window.dispatchEvent(new window.Event('pagehide'));
        const mount = document.getElementById('login-form')?.firstElementChild;
        if (mount) globals.SurveyUI.unmountComponentAtNode(mount as unknown as HTMLElement);
        models.forEach(model => model.dispose());
        vi.restoreAllMocks();
        window.happyDOM.abort(); window.close();
    });
    async function init() {
        window.eval(script);
        await vi.waitFor(() => expect(document.querySelector('input[type="email"]')).not.toBeNull());
    }
    async function requestCode(method: 'email' | 'phone') {
        current().data = { method, ...(method === 'email' ? { email: 'buyer@example.com' } : { phone: '+4917612345678' }) };
        current().doComplete();
        await vi.waitFor(() => {
            expect(codeInput()).not.toBeNull();
            expect(codeInput()!.disabled).toBe(false);
        });
    }

    it.each(['email', 'phone'] as const)('renders the OTP input after %s login and submits the entered code', async method => {
        await init();
        await requestCode(method);
        expect(document.getElementById('login-code-actions')!.hidden).toBe(false);
        expect(document.getElementById('login-form')!.textContent).toContain('Verification code');
        current().setValue('code', '123456');
        current().doComplete();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/shop'));
        const verification = fetchMock.mock.calls.find(([path]) => path === '/auth/login/otp/verify');
        expect(JSON.parse(verification![1].body)).toEqual({ challengeId: 'a'.repeat(64), code: '123456' });
    });

    it('keeps the code input after an incorrect code and after resending', async () => {
        await init(); await requestCode('email');
        fetchMock.mockImplementationOnce(async () => response({ message: 'Invalid login code' }, false));
        current().setValue('code', '000000'); current().doComplete();
        await vi.waitFor(() => expect(document.getElementById('login-status')!.textContent).toBe('Invalid login code'));
        expect(codeInput()).not.toBeNull();
        document.getElementById('login-resend')!.click();
        await vi.waitFor(() => expect(current().getValue('code')).toBeUndefined());
        expect(codeInput()).not.toBeNull();
        expect(redirect).not.toHaveBeenCalled();
    });

    it('renders credentials again when switching methods, then renders a fresh code form', async () => {
        await init(); await requestCode('email');
        document.getElementById('login-back')!.click();
        await vi.waitFor(() => expect(document.querySelector('input[type="email"]')).not.toBeNull());
        expect(codeInput()).toBeNull();
        await requestCode('phone');
        expect(codeInput()).not.toBeNull();
    });
});
