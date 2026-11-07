import { readFileSync } from 'node:fs';
import ts from 'typescript';

/** Run the browser source in Happy DOM using the same target as the client build. */
export function clientScript(name: string): string {
  const fileName = `src/client/${name}.ts`;
  return ts.transpileModule(readFileSync(fileName, 'utf8'), {
    fileName,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;
}
