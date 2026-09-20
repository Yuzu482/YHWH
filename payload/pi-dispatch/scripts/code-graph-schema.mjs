// SPDX-License-Identifier: Apache-2.0
import {z} from 'zod';
export const PARSER_VERSION = 'vscode-tree-sitter-wasm@0.3.1/yhwh-1';
export const LANGUAGES = Object.freeze({'.js':'javascript','.mjs':'javascript','.cjs':'javascript','.jsx':'javascript',
  '.ts':'typescript','.mts':'typescript','.cts':'typescript','.tsx':'tsx','.py':'python'});
const string=z.string().min(1).max(1024), name=z.string().min(1).max(256), line=z.number().int().min(1).max(1048576);
const symbol=z.strictObject({id:string,name,qualified:string,kind:z.enum(['class','function','method','type']),parent:string.nullable(),line,endLine:line});
const imported=z.strictObject({specifier:name,form:z.enum(['import_statement','export_statement','require','import','from']),line});
const mention=z.strictObject({from:string.nullable(),kind:z.enum(['call','construct','base']),name,line});
export const factsSchema=z.strictObject({language:z.enum(['javascript','typescript','tsx','python']),status:z.enum(['parsed','parse-error']),
  symbols:z.array(symbol).max(12000),imports:z.array(imported).max(12000),mentions:z.array(mention).max(12000)});
export const indexSchema=z.strictObject({schemaVersion:z.literal(1),parserVersion:z.string().min(1).max(100),
  files:z.array(z.strictObject({path:z.string().min(1).max(500),sha256:z.string().regex(/^[a-f0-9]{64}$/),facts:factsSchema})).max(512)});
