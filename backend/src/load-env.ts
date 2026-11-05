import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';

// Run before AppModule is imported so module configuration sees NODE_ENV from .env.
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) loadEnvFile(envPath);
