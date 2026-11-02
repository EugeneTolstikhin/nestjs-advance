import { Model } from 'survey-core';
import { loginCodeForm, loginForm } from './login-form';

describe('Login forms', () => {
    it('shows the fields required by each method and clears hidden credentials', () => {
        const model = new Model(loginForm());
        try {
            expect(model.getQuestionByName('password').isVisible).toBe(true);
            expect(model.getQuestionByName('phone').isVisible).toBe(false);
            model.data = { method: 'password', email: 'buyer@example.com', password: 'Password1!' };
            model.setValue('method', 'email');
            expect(model.data.password).toBeUndefined();
            expect(model.getQuestionByName('email').isVisible).toBe(true);
            model.setValue('method', 'phone');
            expect(model.data.email).toBeUndefined();
            expect(model.getQuestionByName('phone').isVisible).toBe(true);
            expect(model.validate()).toBe(false);
            model.setValue('phone', '+4917612345678');
            expect(model.validate()).toBe(true);
        } finally { model.dispose(); }
    });
    it('validates six-digit OTPs, preserving leading zeroes', () => {
        const model = new Model(loginCodeForm());
        try {
            model.setValue('code', 'qwerty'); expect(model.validate()).toBe(false);
            model.setValue('code', '012345'); expect(model.validate()).toBe(true);
        } finally { model.dispose(); }
    });
});
