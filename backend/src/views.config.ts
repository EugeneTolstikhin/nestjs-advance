import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';

export function configureViews(app: NestExpressApplication): void {
    app.setBaseViewsDir(join(__dirname, 'views'));
    app.setViewEngine('hbs');
    app.useStaticAssets(join(__dirname, 'public'), { prefix: '/assets/' });
}
