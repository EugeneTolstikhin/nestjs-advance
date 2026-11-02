import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { Model } from 'survey-core';
import { accountForms } from './account-form';
import { TypeOfUser } from '../auth.dto';

const script = readFileSync('src/public/account.js', 'utf8');
const keyboard = readFileSync('src/public/survey-keyboard.js', 'utf8');
const core = readFileSync('node_modules/survey-core/survey.core.min.js', 'utf8');
const ui = readFileSync('node_modules/survey-js-ui/survey-js-ui.min.js', 'utf8');

describe('Account page with the browser SurveyJS bundles', () => {
    let window: Window;
    let models: Model[];
    let fetchMock: ReturnType<typeof vi.fn>;
    let redirect: ReturnType<typeof vi.spyOn>;
    const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    beforeEach(() => {
        models = [];
        window = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
        window.document.body.innerHTML = '<p id="account-status"></p><div id="buyer-profile-form"></div><div id="seller-profile-form"></div>';
        window.eval(core); window.eval(ui); window.eval(keyboard);
        const globals = window as unknown as { Survey: typeof import('survey-core') };
        const Original = globals.Survey.Model;
        globals.Survey.Model = class extends Original {
            constructor(schema: object) { super(schema); models.push(this); }
        };
        const schema = accountForms({ user: { roles: [TypeOfUser.Buyer] },
            buyerProfile: { deliveryAddress: 'Home address' }, sellerProfile: {} });
        fetchMock = vi.fn().mockImplementation(async path => path === '/account/schema' ? response(schema) : response({ user: { roles: ['buyer', 'seller'] } }));
        window.fetch = fetchMock;
        redirect = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
    });
    afterEach(() => {
        const globals = window as unknown as { SurveyUI: typeof import('survey-js-ui') };
        for (const id of ['buyer-profile-form', 'seller-profile-form']) globals.SurveyUI.unmountComponentAtNode(window.document.getElementById(id) as unknown as HTMLElement);
        models.forEach(model => model.dispose());
        vi.restoreAllMocks(); window.happyDOM.abort(); window.close();
    });
    async function init() {
        window.eval(script);
        await vi.waitFor(() => expect(window.document.querySelectorAll('textarea')).toHaveLength(2));
    }
    it('renders the existing buyer profile and seller enablement form, submitting only seller fields', async () => {
        await init();
        expect(models[0].data.deliveryAddress).toBe('Home address');
        expect(models[0].completeText).toBe('Save profile');
        expect(models[1].completeText).toBe('Enable seller role');
        models[1].data = { companyName: 'My shop', roles: ['admin'], deliveryAddress: 'Wrong profile' };
        models[1].doComplete();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/account'));
        const call = fetchMock.mock.calls.find(([path]) => path === '/account/seller');
        expect(JSON.parse(call![1].body)).toEqual({ companyName: 'My shop' });
    });
    it('keeps both forms usable when saving fails', async () => {
        await init();
        fetchMock.mockImplementationOnce(async () => response({ message: 'Unable to save' }, 503));
        models[0].doComplete();
        await vi.waitFor(() => expect(window.document.getElementById('account-status')!.textContent).toBe('Unable to save'));
        expect(models.every(model => !model.readOnly)).toBe(true);
        expect(window.document.querySelectorAll('textarea')).toHaveLength(2);
        expect(redirect).not.toHaveBeenCalled();
    });

    it('preserves Enter for multiline addresses and submits a seller text field with Enter', async () => {
        await init();
        const textarea = window.document.querySelector('textarea')!;
        textarea.focus();
        const newline = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        textarea.dispatchEvent(newline);
        expect(newline.defaultPrevented).toBe(false);
        expect(fetchMock.mock.calls).toHaveLength(1);
        const company = window.document.querySelector('input[type="text"]')!;
        company.focus(); company.value = 'Keyboard shop';
        company.dispatchEvent(new window.Event('input', { bubbles: true }));
        company.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/account'));
        const call = fetchMock.mock.calls.find(([path]) => path === '/account/seller');
        expect(JSON.parse(call![1].body).companyName).toBe('Keyboard shop');
    });
    it('redirects to login when the session expires before profiles are loaded', async () => {
        fetchMock.mockResolvedValueOnce(response({ message: 'Unauthorized' }, 401));
        window.eval(script);
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/auth/login'));
        expect(models).toHaveLength(0);
    });
});
