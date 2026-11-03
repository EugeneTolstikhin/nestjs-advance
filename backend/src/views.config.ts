import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import hbs from 'hbs';
import type { NextFunction, Request, Response } from 'express';

export async function configureViews(app: NestExpressApplication): Promise<void> {
    await new Promise<void>(resolve => {
        hbs.registerPartials(join(__dirname, 'views', 'includes'), resolve);
    });
    app.setBaseViewsDir(join(__dirname, 'views'));
    app.setViewEngine('hbs');
    app.useStaticAssets(join(__dirname, 'public'), { prefix: '/assets/' });
    // Serve only the pinned browser bundles, not the entire node_modules directory.
    const vendorAssets = new Map([
        ['/assets/vendor/tus.js', join(__dirname, '..', 'node_modules/tus-js-client/dist/tus.min.js')],
        ['/assets/vendor/survey-core.js', join(__dirname, '..', 'node_modules/survey-core/survey.core.min.js')],
        ['/assets/vendor/survey-ui.js', join(__dirname, '..', 'node_modules/survey-js-ui/survey-js-ui.min.js')],
        // The fontless file is an @import alias; its relative URL breaks at this public path.
        ['/assets/vendor/survey.css', join(__dirname, '..', 'node_modules/survey-core/survey-core.min.css')],
    ]);
    app.use((request: Request, response: Response, next: NextFunction) => {
        const file = vendorAssets.get(request.path);
        if (!file || !['GET', 'HEAD'].includes(request.method)) return next();
        response.sendFile(file);
    });
}
