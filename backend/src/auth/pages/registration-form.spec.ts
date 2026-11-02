import 'reflect-metadata';
import { Model } from 'survey-core';
import { registrationForm } from './registration-form';

describe('Registration form flow', () => {
    it('shows one contact field by default and only requests both when explicitly selected', () => {
        const model = new Model(registrationForm());
        try {
            expect(model.getQuestionByName('email').isVisible).toBe(true);
            expect(model.getQuestionByName('phone').isVisible).toBe(false);
            model.setValue('contactMethod', 'phone');
            expect(model.getQuestionByName('email').isVisible).toBe(false);
            expect(model.getQuestionByName('phone').isVisible).toBe(true);
            model.setValue('contactMethod', 'both');
            expect(model.getQuestionByName('email').isVisible).toBe(true);
            expect(model.getQuestionByName('phone').isVisible).toBe(true);
            expect(model.getQuestionByName('email').isRequired).toBe(true);
            expect(model.getQuestionByName('phone').isRequired).toBe(true);
        } finally { model.dispose(); }
    });

    it('clears an excluded contact so it is not accidentally submitted for verification', () => {
        const model = new Model(registrationForm());
        try {
            model.setValue('contactMethod', 'both');
            model.setValue('email', 'test@example.com');
            model.setValue('phone', '+4917612345678');
            model.setValue('contactMethod', 'email');
            expect(model.data.phone).toBeUndefined();
            expect(model.data.email).toBe('test@example.com');
        } finally { model.dispose(); }
    });

    it('splits account, details and password into three steps without a duplicate form title', () => {
        const model = new Model(registrationForm());
        try {
            expect(model.pages.map(page => page.name)).toEqual(['account', 'personal', 'security']);
            expect(model.showTitle).toBe(false);
            expect(model.getQuestionByName('password').page.name).toBe('security');
        } finally { model.dispose(); }
    });
});
