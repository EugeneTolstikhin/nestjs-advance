import { MAX_PRODUCT_STOCK } from '../stock';

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
            { type: 'text', name: 'stock', title: 'Stock quantity', inputType: 'number', min: 0, max: MAX_PRODUCT_STOCK,
                step: 1, defaultValue: 0, isRequired: true,
                description: 'Units available to buy. Use 0 for an out-of-stock product. When editing, change this only to correct the total count.',
                validators: [{ type: 'regex', regex: '^\\d+$', text: 'Enter a whole number, 0 or greater.' }] },
            { type: 'text', name: 'restockQuantity', title: 'Add a new delivery to stock', inputType: 'number', min: 0, max: MAX_PRODUCT_STOCK,
                step: 1, defaultValue: 0, visible: false,
                description: 'Enter the extra units received. Leave the stock quantity above unchanged; the delivery is added to the latest count.',
                validators: [{ type: 'regex', regex: '^\\d+$', text: 'Enter a whole number, 0 or greater.' }] },
        ],
    };
}
