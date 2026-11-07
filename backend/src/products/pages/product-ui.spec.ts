import { clientScript } from '../../../test/client-script';
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import type { Model } from 'survey-core';
import { productForm } from './product-form';

const core = readFileSync('node_modules/survey-core/survey.core.min.js', 'utf8');
const ui = readFileSync('node_modules/survey-js-ui/survey-js-ui.min.js', 'utf8');
const keyboard = clientScript('survey-keyboard');
const editorScript = clientScript('product-editor');
const deleteScript = clientScript('products');
const id = 'aab55f70-d80e-4f7c-a582-04a64dc83199';

describe('Product browser UI', () => {
    let window: Window;
    let models: Model[];
    let fetchMock: ReturnType<typeof vi.fn>;
    let redirect: ReturnType<typeof vi.spyOn>;
    let globals: { Survey: typeof import('survey-core'); SurveyUI: typeof import('survey-js-ui') };
    const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    beforeEach(() => {
        models = [];
        window = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
        window.eval(core); window.eval(ui); window.eval(keyboard);
        globals = window as unknown as typeof globals;
        const Original = globals.Survey.Model;
        globals.Survey.Model = class extends Original { constructor(schema: object) { super(schema); models.push(this); } };
        fetchMock = vi.fn().mockImplementation(async (path, options) => {
            if (path === '/shop/product-schema') return response(productForm());
            if (!options?.method) return response({ id, name: 'Book', description: 'Existing description', price: 10 });
            return response({ id });
        });
        window.fetch = fetchMock;
        redirect = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    });
    afterEach(() => {
        const container = window.document.getElementById('product-form');
        if (container && models.length) globals.SurveyUI.unmountComponentAtNode(container as unknown as HTMLElement);
        models.forEach(model => model.dispose()); vi.restoreAllMocks();
        window.happyDOM.abort(); window.close();
    });
    async function editor(productId = '', media = false) {
        window.document.body.innerHTML = `<main id="product-page" data-product-id="${productId}"><p id="product-status"></p>${media ? '<section id="product-media"></section>' : ''}<div id="product-form"></div></main>`;
        window.eval(editorScript);
        await vi.waitFor(() => expect(window.document.querySelector('input[type="number"]')).not.toBeNull());
        return models[0];
    }
    function deletion() {
        window.document.body.innerHTML = `<section class="products"><article class="product"><h2>Book &lt;script&gt;</h2><button data-delete-product="${id}">Delete</button></article></section>
            <dialog id="delete-product-dialog"><span id="delete-product-name"></span><p id="delete-product-status"></p><button id="cancel-delete-product">Keep product</button><button id="confirm-delete-product">Delete product</button></dialog>`;
        window.eval(deleteScript);
        window.document.querySelector('button[data-delete-product]')!.click();
    }

    it('creates a product with numeric price and only editable product fields', async () => {
        const model = await editor();
        expect(model.getQuestionByName('imageUrl')).toBeNull();
        model.data = { name: '  New book  ', description: 'New description', price: 0 };
        await vi.waitFor(() => expect(window.document.querySelector('input[type="text"]')!.value).toBe('  New book  '));
        model.tryComplete(); model.tryComplete();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/shop'));
        const calls = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe('/products');
        expect(JSON.parse(calls[0][1].body)).toEqual({ name: 'New book', description: 'New description', price: 0 });
        expect(calls[0][1].credentials).toBe('same-origin');
    });
    it('loads product values and saves edits through PUT without a body ID', async () => {
        const model = await editor(id);
        expect(model.data.name).toBe('Book');
        model.setValue('name', 'Updated book');
        await vi.waitFor(() => expect(window.document.querySelector('input[type="text"]')!.value).toBe('Updated book'));
        model.tryComplete();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/shop'));
        const call = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
        expect(call![0]).toBe(`/products/${id}`);
        expect(JSON.parse(call![1].body)).toEqual({ name: 'Updated book', description: 'Existing description', price: 10 });
    });
    it('validates prices, required text before making a write request', async () => {
        const model = await editor();
        for (const data of [{ name: '', description: 'Test', price: 1 }, { name: 'Book', description: ' ', price: 1 },
            { name: 'Book', description: 'Test', price: -1 }, { name: 'Book', description: 'Test', price: 1.234 }]) {
            model.data = data; model.tryComplete();
        }
        expect(fetchMock.mock.calls.filter(([, options]) => options?.method)).toHaveLength(0);
        expect(redirect).not.toHaveBeenCalled();
    });
    it('keeps edits on a duplicate-name error and allows retrying', async () => {
        const model = await editor(id);
        fetchMock.mockResolvedValueOnce(response({ message: 'A product with this name already exists' }, 409));
        model.tryComplete();
        await vi.waitFor(() => expect(window.document.getElementById('product-status')!.textContent).toContain('already exists'));
        expect(model.readOnly).toBe(false); expect(model.data.name).toBe('Book');
        expect(redirect).not.toHaveBeenCalled();
        model.tryComplete();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/shop'));
    });
    it('shows a session expiry message without discarding the form', async () => {
        const model = await editor(id);
        fetchMock.mockResolvedValueOnce(response({ message: 'Unauthorized' }, 401)); model.tryComplete();
        await vi.waitFor(() => expect(window.document.getElementById('product-status')!.textContent).toContain('session has expired'));
        expect(model.readOnly).toBe(false); expect(model.data.description).toBe('Existing description');
    });
    it('blocks saving pending uploads, then submits ordered media IDs with the product', async () => {
        const uploader = { ids: vi.fn().mockImplementation(() => { throw new Error('Finish pending uploads'); }),
            setLocked: vi.fn(), markSaved: vi.fn().mockResolvedValue(undefined) };
        (window as any).ProductMediaUploader = { create: vi.fn().mockResolvedValue(uploader) };
        const model = await editor(id, true);
        model.tryComplete();
        expect(window.document.getElementById('product-status')!.textContent).toContain('pending uploads');
        expect(fetchMock.mock.calls.some(([, options]) => options?.method)).toBe(false);
        uploader.ids.mockReturnValue([id]); model.tryComplete();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/shop'));
        const call = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT');
        expect(JSON.parse(call![1].body).mediaIds).toEqual([id]);
        expect(uploader.markSaved).toHaveBeenCalledTimes(1);
        expect(uploader.setLocked).toHaveBeenCalledWith(true);
    });
    it('cancels deletion without sending a request and returns focus to the delete control', async () => {
        deletion();
        expect(window.document.getElementById('delete-product-dialog')!.open).toBe(true);
        expect(window.document.getElementById('delete-product-name')!.textContent).toBe('Book <script>');
        window.document.getElementById('cancel-delete-product')!.click();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(window.document.activeElement).toBe(window.document.querySelector('button[data-delete-product]'));
    });
    it('deletes only after confirmation and sends one request', async () => {
        deletion();
        expect(fetchMock).not.toHaveBeenCalled();
        window.document.getElementById('confirm-delete-product')!.click();
        window.document.getElementById('confirm-delete-product')!.click();
        await vi.waitFor(() => expect(redirect).toHaveBeenCalledWith('/shop'));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(`/products/${id}`);
        expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    });
    it('retains the delete dialog and enables retry when deletion fails', async () => {
        deletion(); fetchMock.mockResolvedValueOnce(response({ message: 'Unavailable' }, 503));
        window.document.getElementById('confirm-delete-product')!.click();
        await vi.waitFor(() => expect(window.document.getElementById('delete-product-status')!.textContent).toBe('Unavailable'));
        expect(window.document.getElementById('delete-product-dialog')!.open).toBe(true);
        expect(window.document.getElementById('confirm-delete-product')!.disabled).toBe(false);
        expect(redirect).not.toHaveBeenCalled();
    });
});
