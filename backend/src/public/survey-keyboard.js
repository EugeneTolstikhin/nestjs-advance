// Share the same keyboard behavior across login, registration and account forms.
globalThis.SurveyKeyboard = Object.freeze({
    attach(container, getSurvey, isBusy = () => false) {
        function proceed() {
            const survey = getSurvey();
            if (!survey || survey.readOnly || isBusy()) return;
            // Commit SurveyJS editors that update their value on blur before validation.
            const focused = document.activeElement;
            if (focused && container.contains(focused)) focused.blur();
            if (survey.isLastPage) survey.tryComplete();
            else survey.nextPageUIClick();
        }
        container.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat ||
                event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            const input = event.target;
            // Leave buttons, multiline fields, radio groups and dropdowns with
            // their native keyboard behavior. IME confirmation must not submit.
            if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly ||
                !['text', 'email', 'password', 'tel', 'number', 'url', 'search'].includes(input.type) ||
                input.closest('[role="combobox"], [role="listbox"], [role="menu"]')) return;
            event.preventDefault();
            proceed();
        });
        // Also support native/assistive form submission, including mobile keyboards.
        container.addEventListener('submit', event => {
            event.preventDefault();
            proceed();
        });
    },
});
