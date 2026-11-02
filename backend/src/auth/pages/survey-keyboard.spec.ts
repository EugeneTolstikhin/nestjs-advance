import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { Model } from 'survey-core';
import { registrationForm } from './registration-form';

const core = readFileSync('node_modules/survey-core/survey.core.min.js', 'utf8');
const ui = readFileSync('node_modules/survey-js-ui/survey-js-ui.min.js', 'utf8');
const keyboard = readFileSync('src/public/survey-keyboard.js', 'utf8');

describe('Survey keyboard navigation with browser bundles', () => {
    let window: Window;
    let survey: Model;
    let complete: ReturnType<typeof vi.fn>;
    let busy: boolean;
    let globals: { Survey: typeof import('survey-core'); SurveyUI: typeof import('survey-js-ui');
        SurveyKeyboard: { attach: (container: unknown, getSurvey: () => Model, isBusy: () => boolean) => void } };
    beforeEach(() => {
        window = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
        window.eval(core); window.eval(ui); window.eval(keyboard);
        globals = window as unknown as typeof globals;
        window.document.body.innerHTML = '<div id="survey"></div>';
        busy = false; complete = vi.fn();
    });
    afterEach(() => {
        globals.SurveyUI.unmountComponentAtNode(window.document.getElementById('survey') as unknown as HTMLElement);
        survey?.dispose(); window.happyDOM.abort(); window.close();
    });
    function render(schema: object) {
        survey = new globals.Survey.Model(schema);
        survey.onCompleting.add((_sender, options) => { options.allow = false; complete(); });
        const container = window.document.getElementById('survey')!;
        globals.SurveyKeyboard.attach(container, () => survey, () => busy);
        survey.render(container as unknown as HTMLElement);
    }
    function input(name: string) { return window.document.getElementById(survey.getQuestionByName(name).inputId)!; }
    function enter(element: ReturnType<typeof input>, options = {}) {
        element.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true, ...options }));
    }
    function type(name: string, value: string) {
        const field = input(name) as unknown as HTMLInputElement;
        field.focus(); field.value = value;
        field.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
        return input(name);
    }

    it('uses Continue on registration pages and validates required fields before advancing', async () => {
        render(registrationForm());
        survey.setValue('typeOfUser', 'buyer');
        await vi.waitFor(() => expect(input('email')).not.toBeNull());
        input('email').focus(); enter(input('email'));
        expect(survey.currentPageNo).toBe(0);
        expect(survey.getQuestionByName('email').errors.length).toBeGreaterThan(0);
        enter(type('email', 'buyer@example.com'));
        await vi.waitFor(() => expect(survey.currentPageNo).toBe(1));
        survey.setValue('firstName', 'Test'); survey.setValue('lastName', 'Buyer');
        survey.setValue('dob', '2000-01-01'); survey.setValue('nationality', 'Germany');
        await vi.waitFor(() => expect(input('lastName')).not.toBeNull());
        enter(input('lastName'));
        await vi.waitFor(() => expect(survey.currentPageNo).toBe(2));
        await vi.waitFor(() => expect(input('password')).not.toBeNull());
        type('password', 'Password1!'); enter(type('confirmPassword', 'Password1!'));
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    });

    it('ignores IME confirmation, held keys, modifier shortcuts and busy forms', async () => {
        render({ elements: [{ type: 'text', name: 'value' }] });
        await vi.waitFor(() => expect(input('value')).not.toBeNull());
        for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { metaKey: true }]) enter(input('value'), options);
        busy = true; enter(input('value'));
        busy = false; survey.readOnly = true; enter(input('value'));
        expect(complete).not.toHaveBeenCalled();
    });

    it('supports native form submission and retains SurveyJS validation', async () => {
        render({ elements: [{ type: 'text', name: 'value', isRequired: true }] });
        const form = window.document.querySelector('form')!;
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        expect(complete).not.toHaveBeenCalled();
        type('value', 'Valid');
        form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
        expect(complete).toHaveBeenCalledTimes(1);
    });
});
