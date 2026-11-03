export function productForm() {
    return {
        showTitle: false, showQuestionNumbers: 'off', widthMode: 'responsive', completeText: 'Save product',
        elements: [
            { type: 'text', name: 'name', title: 'Product name', isRequired: true, maxLength: 100,
                placeholder: 'For example, Apple iPhone 13', validators: [{ type: 'regex', regex: '\\S', text: 'Enter a product name.' }] },
            { type: 'comment', name: 'description', title: 'Description', isRequired: true, maxLength: 255,
                validators: [{ type: 'regex', regex: '\\S', text: 'Enter a description.' }] },
            { type: 'text', name: 'price', title: 'Price', inputType: 'number', min: 0, step: 0.01, isRequired: true,
                description: 'Enter a non-negative amount with up to two decimal places.',
                validators: [{ type: 'regex', regex: '^\\d+(\\.\\d{1,2})?$', text: 'Enter a valid price with up to two decimal places.' }] },
            { type: 'text', name: 'imageUrl', title: 'Image URL (optional)', inputType: 'url',
                placeholder: 'https://example.com/product.jpg',
                description: 'Use a direct link to an image. Leave blank to show a placeholder.',
                validators: [{ type: 'regex', regex: '^https?://\\S+$', text: 'Enter a full HTTP or HTTPS image URL.' }] },
        ],
    };
}
