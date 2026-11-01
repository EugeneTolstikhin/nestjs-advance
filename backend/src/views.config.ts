import type { NestExpressApplication } from '@nestjs/platform-express';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import hbs from 'hbs';

export function configureViews(app: NestExpressApplication): void {
    hbs.registerPartial('navbar', readFileSync(join(__dirname, 'views', 'includes', 'navbar.hbs'), 'utf8'));
    app.setBaseViewsDir(join(__dirname, 'views'));
    app.setViewEngine('hbs');
    app.useStaticAssets(join(__dirname, 'public'), { prefix: '/assets/' });
}
