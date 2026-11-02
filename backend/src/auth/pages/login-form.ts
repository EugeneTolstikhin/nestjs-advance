export function loginForm() {
    return {
        showTitle: false, showQuestionNumbers: 'off', widthMode: 'responsive',
        completeText: 'Continue', clearInvisibleValues: 'onHidden',
        elements: [
            { type: 'radiogroup', name: 'method', title: 'How would you like to log in?',
                defaultValue: 'password', isRequired: true, colCount: 3,
                choices: [{ value: 'password', text: 'Email & password' },
                    { value: 'email', text: 'Email code' }, { value: 'phone', text: 'Phone code' }] },
            { type: 'text', name: 'email', title: 'Email', inputType: 'email', autocomplete: 'email',
                placeholder: 'you@example.com', maxLength: 254, isRequired: true,
                visibleIf: "{method} != 'phone'", validators: [{ type: 'email' }] },
            { type: 'text', name: 'phone', title: 'Phone number', inputType: 'tel', autocomplete: 'tel',
                placeholder: '+4917612345678', isRequired: true, visibleIf: "{method} = 'phone'",
                validators: [{ type: 'regex', regex: '^\\+[1-9]\\d{1,14}$', text: 'Include + and your country code.' }] },
            { type: 'text', name: 'password', title: 'Password', inputType: 'password',
                autocomplete: 'current-password', maxLength: 72, isRequired: true, visibleIf: "{method} = 'password'" },
        ],
    };
}

export function loginCodeForm() {
    return {
        showTitle: false, showQuestionNumbers: 'off', widthMode: 'responsive', completeText: 'Log in',
        elements: [{ type: 'text', name: 'code', title: 'Verification code', isRequired: true,
            autocomplete: 'one-time-code', inputType: 'text', maxLength: 6,
            validators: [{ type: 'regex', regex: '^\\d{6}$', text: 'Enter the six-digit code.' }] }],
    };
}
